#!/usr/bin/env node
/**
 * Headless driver for the agent runtime — how the evaluation harness runs it,
 * and the proof that the runtime does not depend on the UI.
 *
 * Commands:
 *   run <prompt> [--project DIR] [--yes] [--test CMD]
 *   resume [<taskId>] [--project DIR] [--yes]     resume an interrupted task
 *   providers                                     configured / reachable
 *   trace <taskId> [--project DIR]                print the call hierarchy
 */

import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { stdin, stdout } from 'node:process';

import {
  createAgent, runTask, stopBackground, type TaskOutcome,
} from './agent/orchestrator.ts';
import { PROVIDERS, assertLegalCatalogue } from './agent/providers.ts';
import { scoreTask } from './agent/router.ts';
import { Store } from './agent/store.ts';
import type { ApprovalFn, ToolCall } from './agent/types.ts';
// Same key resolution as the web server: the Settings screen's file first,
// the environment filling gaps — a key entered in the UI works here too.
import { effectiveKeys } from './web/settings.ts';

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'run':       return runCommand(rest);
    case 'resume':    return resumeCommand(rest);
    case 'providers': return showProviders();
    case 'trace':     return showTrace(rest);
    default:          return usage();
  }
}

function usage(): void {
  console.log(`
agentzero — headless agent runtime

  run <prompt>         Run a task in the current project
    --project DIR        Project root (default: cwd)
    --yes                Auto-approve side-effecting tools (batch runs only)
    --test "CMD"         Command that runs the test suite, used by verification

  resume [<taskId>]    Resume an interrupted task (latest one if no id given)
  providers            Show which providers are configured and reachable
  trace <taskId>       Print the call hierarchy for a task

Keys come from ~/.agentzero/settings.json (the UI's Settings screen) or the
environment; see .env.example.
`.trim());
}

// ---------------------------------------------------------------------------

async function runCommand(args: string[]): Promise<void> {
  const prompt = args.filter((a) => !a.startsWith('--'))[0];
  if (!prompt) { usage(); process.exitCode = 1; return; }
  await startTask(args, prompt, undefined);
}

async function resumeCommand(args: string[]): Promise<void> {
  const projectRoot = resolve(flag(args, '--project') ?? process.cwd());
  let taskId = args.filter((a) => !a.startsWith('--') && a !== flag(args, '--project'))[0];

  if (!taskId) {
    const db = new Store(projectRoot);
    try {
      const candidates = db.listResumable(projectRoot);
      if (candidates.length === 0) { console.log('Nothing to resume.'); return; }
      taskId = candidates[0]!.id;
      console.log(`Resuming latest interrupted task: ${taskId}`);
    } finally {
      db.close();
    }
  }
  await startTask(args, '', taskId);
}

async function startTask(
  args: string[], prompt: string, resumeTaskId: string | undefined,
): Promise<void> {
  const projectRoot = resolve(flag(args, '--project') ?? process.cwd());
  const testCommand = flag(args, '--test');

  const keys = effectiveKeys();
  if (keys.size === 0) {
    console.warn(
      'No API keys found in the environment. Set at least one of the keys\n' +
      'listed in .env.example (or add one on the Settings screen), or enable Ollama.\n');
  }

  const agent = await createAgent({
    projectRoot,
    keys,
    approval: args.includes('--yes') ? autoApprove : terminalApproval,
    ...(testCommand ? { testCommand } : {}),
    onProgress: (m) => console.log(`  ${m}`),
    onRoute: (d) => console.log(`  -> [${d.providerId}] ${d.modelId}  (${d.reason})`),
  });

  try {
    console.log(`\nProject: ${projectRoot}`);
    if (prompt) console.log(`Task: ${prompt}\n`);
    const outcome = await runTask(agent, prompt,
      resumeTaskId ? { resumeTaskId } : {});
    printOutcome(outcome);
    if (agent.background.length > 0) {
      // Headless runs have no one to hand a live server to, so say what was
      // started and stop it rather than leaving orphans behind.
      console.log(`\nStopping ${agent.background.length} background process(es) ` +
                  `started during this task.`);
    }
  } finally {
    stopBackground(agent);
    agent.db.close();
  }
}

function printOutcome(outcome: TaskOutcome): void {
  const seconds = outcome.elapsedMs / 1000;
  console.log(`
--- result ---------------------------------------------------
status      ${outcome.status}${outcome.abortReason ? `  (${outcome.abortReason})` : ''}
steps       ${outcome.stepsCompleted}/${outcome.stepsTotal}
cost        $${outcome.costUsd.toFixed(5)}
tokens      ${outcome.tokens.toLocaleString()}
time        ${seconds.toFixed(1)}s
score@A=1   ${scoreTask(1, outcome.costUsd, seconds).toFixed(2)}  (of a 10 maximum)
task id     ${outcome.taskId}
`.trim());

  if (outcome.diff.trim()) {
    console.log(`\n--- proposed diff --------------------------------------------\n`);
    console.log(outcome.diff);
  } else {
    console.log('\nNo changes were made.');
  }
}

// ---------------------------------------------------------------------------

/** ONLY for unattended batch runs — everything is approved unread. */
const autoApprove: ApprovalFn = async () => true;

/** Ask in the terminal, showing the exact command or file contents. */
const terminalApproval: ApprovalFn = async (call: ToolCall) => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log(`\n  ${'-'.repeat(66)}`);
    console.log(`  APPROVAL NEEDED: ${call.name}`);

    if (call.name === 'run_command') {
      console.log(`\n    $ ${String(call.args.command ?? '')}\n`);
      console.log('  This runs on your machine and is not confined to the project.');
    } else if (call.name === 'write_file') {
      const lines = String(call.args.content ?? '').split('\n');
      console.log(`\n    write ${String(call.args.path)}  (${lines.length} lines)\n`);
      for (const line of lines.slice(0, 20)) console.log(`    | ${line}`);
      if (lines.length > 20) console.log(`    | ... ${lines.length - 20} more lines`);
    }
    console.log(`  ${'-'.repeat(66)}`);

    const answer = await rl.question('  allow? [y/N] ');
    return answer.trim().toLowerCase().startsWith('y');
  } finally {
    rl.close();
  }
};

// ---------------------------------------------------------------------------

/** Free model line-ups rotate without notice; "it worked yesterday" is not evidence. */
async function showProviders(): Promise<void> {
  assertLegalCatalogue();
  const keys = effectiveKeys();

  console.log('\nprovider          key      models  status');
  console.log('-'.repeat(62));
  for (const provider of PROVIDERS) {
    const configured = provider.keyEnv === null || keys.has(provider.id);
    const state = !provider.enabled ? 'disabled'
      : !configured ? `set ${provider.keyEnv}`
      : await ping(provider.baseUrl, keys.get(provider.id));
    console.log(
      `${provider.id.padEnd(17)} ${(configured ? 'yes' : 'no').padEnd(8)} ` +
      `${String(provider.models.length).padEnd(7)} ${state}`);
  }

  console.log('\nlegal models (<=80B total parameters):');
  for (const provider of PROVIDERS) {
    for (const model of provider.models) {
      console.log(
        `  ${`${provider.id}/${model.id}`.padEnd(46)} ` +
        `${String(model.totalParamsB).padStart(3)}B  ${model.roles.join(',')}`);
    }
  }
  console.log();
}

async function ping(baseUrl: string, key?: string): Promise<string> {
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal });
    clearTimeout(timer);
    return res.ok ? 'reachable' : `http ${res.status}`;
  } catch (err) {
    return `unreachable (${(err as Error).message.slice(0, 30)})`;
  }
}

/** The call hierarchy, rendered straight from parent_id. */
async function showTrace(args: string[]): Promise<void> {
  const taskId = args[0];
  const projectRoot = resolve(flag(args, '--project') ?? process.cwd());
  if (!taskId) { usage(); process.exitCode = 1; return; }

  const db = new Store(projectRoot);
  try {
    const events = db.getEvents(taskId);
    if (events.length === 0) { console.log('No such task in this project.'); return; }

    const children = new Map<number | null, typeof events>();
    for (const ev of events) {
      children.set(ev.parentId, [...(children.get(ev.parentId) ?? []), ev]);
    }

    const walk = (parentId: number | null, depth: number): void => {
      for (const ev of children.get(parentId) ?? []) {
        const cost = ev.costUsd > 0 ? ` $${ev.costUsd.toFixed(5)}` : '';
        const tok = ev.tokensIn + ev.tokensOut > 0 ? ` ${ev.tokensIn}+${ev.tokensOut}tok` : '';
        const ms = ev.durationMs > 0 ? ` ${ev.durationMs}ms` : '';
        const where = ev.model ? ` [${ev.provider}/${ev.model}]` : '';
        const bad = ev.status === 'error' ? ' !' : '';
        console.log(
          `${'  '.repeat(depth)}${ev.kind}${ev.role ? `:${ev.role}` : ''}` +
          `${where}${tok}${cost}${ms}${bad}`);
        walk(ev.id, depth + 1);
      }
    };

    console.log();
    walk(null, 0);
    const totals = db.totals(taskId);
    console.log(
      `\ntotals  $${totals.costUsd.toFixed(5)}  ${totals.tokens.toLocaleString()} tokens  ` +
      `${(totals.durationMs / 1000).toFixed(1)}s in model calls\n`);
  } finally {
    db.close();
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

main().catch((err) => {
  console.error(`\nerror: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
