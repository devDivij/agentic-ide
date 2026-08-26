/**
 * The orchestrator: one deterministic loop, written in code.
 *
 *   classify → retrieve → plan → per step: [ retrieve, execute turns,
 *   verify, checkpoint | revert ] → final diff → human review
 *
 * Control flow is NEVER delegated to a model. Models fill slots (a plan, a
 * turn, a failure label); the loop decides what happens next. This is the
 * single most important choice in the system and it follows from what a ≤80B
 * model cannot do: hold a long horizon, notice it is looping, or judge its
 * own output reliably.
 *
 * Three safety properties are structural rather than defended:
 *   - runaway agent spawning is unrepresentable — one loop, no recursion;
 *   - progress survives any single call dying — state lives in SQLite,
 *     never inside a conversation (which is also what makes resume work);
 *   - every ceiling we enforce sits inside the evaluation's hard limits, so
 *     we abort cleanly with a partial diff instead of being halted at zero.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ApprovalFn, CodeChunk, FailureClass, Plan, PlanStep, StepRecord, Task,
} from './types.ts';
import { Store } from './store.ts';
import { Router, BUDGETS, type RouteDecision } from './router.ts';
import { Retriever } from './retrieval.ts';
import { Checkpoints, assertGitAvailable } from './checkpoints.ts';
import { assertLegalCatalogue, PROVIDERS } from './providers.ts';
import { runTool } from './tools.ts';
import { verifyChanges } from './verify.ts';
import { CallFailedError } from './call.ts';
import {
  classifyTask, diagnoseFailure, executeTurn, makePlan,
} from './workers.ts';

/** Turns one executor step may take before we call it stuck. */
const MAX_TURNS_PER_STEP = 12;

/**
 * Everything a task run needs, wired once in createAgent(). There is no
 * dependency-injection framework and no interfaces-with-one-implementation:
 * to swap the retriever, edit retrieval.ts.
 */
export interface Agent {
  projectRoot: string;
  db: Store;
  router: Router;
  keys: Map<string, string>;
  retriever: Retriever;
  checkpoints: Checkpoints;
  /** AGENTS.md contents, injected into every context. */
  projectRules: string | null;
  approval: ApprovalFn;
  testCommand?: string;
  onProgress?: (message: string) => void;
}

export interface AgentOptions {
  projectRoot: string;
  /** provider id → api key. Providers without keys are simply not routed to. */
  keys: Map<string, string>;
  approval: ApprovalFn;
  testCommand?: string;
  onProgress?: (message: string) => void;
  onRoute?: (decision: RouteDecision & { role: string }) => void;
}

export async function createAgent(opts: AgentOptions): Promise<Agent> {
  assertLegalCatalogue();          // refuse to run a non-compliant build
  await assertGitAvailable();

  const retriever = new Retriever(opts.projectRoot);
  return {
    projectRoot: opts.projectRoot,
    db: new Store(opts.projectRoot),
    router: new Router(new Set(opts.keys.keys()), opts.onRoute),
    keys: opts.keys,
    retriever,
    checkpoints: new Checkpoints(opts.projectRoot),
    projectRules: await readProjectRules(opts.projectRoot),
    approval: opts.approval,
    ...(opts.testCommand ? { testCommand: opts.testCommand } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  };
}

/** AGENTS.md if present (conventional filenames, in preference order). */
async function readProjectRules(projectRoot: string): Promise<string | null> {
  for (const name of ['AGENTS.md', 'agents.md', 'CLAUDE.md']) {
    try {
      const text = await readFile(join(projectRoot, name), 'utf8');
      if (text.trim()) return text.trim();
    } catch { /* try the next candidate */ }
  }
  return null;
}

/** Read provider keys from the environment (the settings screen adds more). */
export function keysFromEnv(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const keys = new Map<string, string>();
  for (const provider of PROVIDERS) {
    if (!provider.keyEnv) continue;
    const value = env[provider.keyEnv];
    if (value?.trim()) keys.set(provider.id, value.trim());
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Running a task
// ---------------------------------------------------------------------------

export interface TaskOutcome {
  taskId: string;
  status: Task['status'];
  /** Unified diff of everything the agent changed, for review. */
  diff: string;
  stepsCompleted: number;
  stepsTotal: number;
  costUsd: number;
  tokens: number;
  elapsedMs: number;
  abortReason?: string;
}

/**
 * Run a task to completion — or resume one that was interrupted.
 *
 * Resume is possible because nothing lives in a conversation: the plan, step
 * statuses, facts and checkpoints are all in SQLite, so we reload them and
 * continue from the first step that is not already done.
 */
export async function runTask(
  agent: Agent, prompt: string, opts: { resumeTaskId?: string } = {},
): Promise<TaskOutcome> {
  const startedAt = Date.now();
  const { db } = agent;

  // --- create or reload the task -------------------------------------------
  let task: Task;
  let resumedPlan: Plan | null = null;
  if (opts.resumeTaskId) {
    const existing = db.getTask(opts.resumeTaskId);
    if (!existing) throw new Error(`No such task to resume: ${opts.resumeTaskId}`);
    task = existing;
    resumedPlan = db.getPlan(task.id);
    db.setStatus(task.id, 'running');
    report(agent, `Resuming task ${task.id.slice(0, 8)}: ${task.prompt.slice(0, 60)}`);
  } else {
    task = {
      id: randomUUID(),
      projectRoot: agent.projectRoot,
      prompt,
      status: 'running',
      complexity: 'medium',            // provisional until classified
      createdAt: startedAt,
      budget: BUDGETS.medium,
    };
    db.createTask(task);
  }

  const rootId = db.appendEvent({
    taskId: task.id, kind: 'task_start',
    payload: { prompt: task.prompt, projectRoot: agent.projectRoot, resumed: !!opts.resumeTaskId },
  });

  // --- baseline snapshot ----------------------------------------------------
  // On resume, keep the ORIGINAL baseline so the final diff still covers the
  // whole task, not just the part after the restart.
  let baseSha = opts.resumeTaskId ? db.getBaseSha(task.id) : null;
  if (!baseSha) {
    baseSha = await agent.checkpoints.init();
    db.setBaseSha(task.id, baseSha);
  }
  db.appendEvent({
    taskId: task.id, parentId: rootId, kind: 'checkpoint',
    payload: { sha: baseSha, label: 'baseline' },
  });

  try {
    // --- classify (skipped on resume: already done and paid for) ------------
    if (!opts.resumeTaskId) {
      const { complexity, reason } = await classifyTask(agent, task, rootId);
      task = { ...task, complexity, budget: BUDGETS[complexity] };
      db.setComplexity(task);
      report(agent, `Task classified as ${complexity} (${reason})`);
    }

    // --- user pins: @path and @path:12-40 tags in the prompt ----------------
    const pinned = await loadPins(agent, task, opts.resumeTaskId !== undefined);

    // --- plan (reused on resume) --------------------------------------------
    let plan = resumedPlan;
    if (!plan) {
      const seedChunks = await agent.retriever.retrieve(task.prompt, [], 10);
      db.appendEvent({
        taskId: task.id, parentId: rootId, kind: 'tool_call',
        payload: { tool: 'retrieve',
                   chunks: seedChunks.map((c) => `${c.path}:${c.startLine}-${c.endLine}`) },
      });
      // The planner gets the real file list: without it, a model confidently
      // names a plausible path that does not exist, and the executor then
      // burns its turn budget chasing it.
      const projectFiles = await agent.retriever.listPaths();
      plan = await makePlan(agent, task, seedChunks, pinned, projectFiles, rootId);
      db.savePlan(task.id, plan);
      for (const step of plan.steps) {
        db.upsertStep({ taskId: task.id, stepId: step.id, spec: step,
                        status: 'pending', checkpointSha: null, attempts: 0 });
      }
      report(agent, `Plan: ${plan.steps.length} steps — ${plan.summary}`);
    } else {
      const done = db.getSteps(task.id).filter((s) => s.status === 'done').length;
      report(agent, `Reusing stored plan (${done}/${plan.steps.length} steps already done)`);
    }

    // --- execute -------------------------------------------------------------
    const abortReason = await runSteps(agent, task, plan, pinned, rootId, startedAt);

    // --- finish --------------------------------------------------------------
    const headSha = await agent.checkpoints.commit('final state');
    const diff = await agent.checkpoints.diff(baseSha, headSha);
    db.appendEvent({
      taskId: task.id, parentId: rootId, kind: 'checkpoint',
      payload: { sha: headSha, label: 'final', baseSha },
    });

    const steps = db.getSteps(task.id);
    const done = steps.filter((s) => s.status === 'done').length;
    const status: Task['status'] = abortReason
      ? 'aborted'
      : done === plan.steps.length ? 'awaiting_review' : 'failed';
    db.setStatus(task.id, status);

    const totals = db.totals(task.id);
    db.appendEvent({
      taskId: task.id, parentId: rootId, kind: 'task_end',
      payload: { status, abortReason, stepsCompleted: done },
    });

    return {
      taskId: task.id, status, diff,
      stepsCompleted: done, stepsTotal: plan.steps.length,
      costUsd: totals.costUsd, tokens: totals.tokens,
      elapsedMs: Date.now() - startedAt,
      ...(abortReason ? { abortReason } : {}),
    };

  } catch (err) {
    // Even a hard failure hands back whatever was accomplished: a partial
    // diff is worth more than nothing, and the checkpoint chain has it.
    const message = (err as Error).message;
    db.setStatus(task.id, 'failed');
    db.appendEvent({
      taskId: task.id, parentId: rootId, kind: 'error',
      payload: { message }, status: 'error',
    });
    const headSha = await agent.checkpoints.commit('state at failure').catch(() => baseSha!);
    const diff = await agent.checkpoints.diff(baseSha!, headSha).catch(() => '');
    const steps = db.getSteps(task.id);
    const totals = db.totals(task.id);
    return {
      taskId: task.id, status: 'failed', diff,
      stepsCompleted: steps.filter((s) => s.status === 'done').length,
      stepsTotal: steps.length,
      costUsd: totals.costUsd, tokens: totals.tokens,
      elapsedMs: Date.now() - startedAt,
      abortReason: message,
    };
  }
}

// ---------------------------------------------------------------------------
// The step loop
// ---------------------------------------------------------------------------

/**
 * Run the plan in dependency order; steps whose dependency failed are skipped.
 * Returns an abort reason, or null when the plan ran to its end.
 *
 * Sequential on purpose: parallelism buys wall-clock but spends coordination
 * and merge verification, and free-tier request limits cap useful concurrency
 * at one or two streams anyway.
 */
async function runSteps(
  agent: Agent, task: Task, plan: Plan, pinned: CodeChunk[],
  rootId: number, startedAt: number,
): Promise<string | null> {
  const db = agent.db;
  // Resume support: steps already done stay done.
  const completed = new Set(
    db.getSteps(task.id).filter((s) => s.status === 'done').map((s) => s.stepId));
  let stepsRun = 0;

  for (const step of orderSteps(plan.steps)) {
    if (completed.has(step.id)) continue;

    const overBudget = checkBudget(agent, task, startedAt, stepsRun);
    if (overBudget) return overBudget;

    if (!step.dependsOn.every((d) => completed.has(d))) {
      markStep(db, task.id, step, 'skipped', null, 0);
      report(agent, `Skipping ${step.id}: a dependency did not complete`);
      continue;
    }

    stepsRun++;
    const ok = await runOneStep(agent, task, plan, step, pinned, rootId);
    if (ok) completed.add(step.id);
  }
  return null;
}

/**
 * How the loop responds to each failure class. The diagnose worker chooses
 * the row; this table chooses the action. Keeping the mapping in code is what
 * makes an unreliable model safe to use for a judgement-shaped job: it
 * labels, we decide.
 */
const TAXONOMY: Record<FailureClass, 'retry' | 'revert' | 'abort'> = {
  malformed_output: 'retry',   // repair already happened inside callModel
  transient_api:    'retry',   // provider swapped underneath; step untouched
  patch_conflict:   'retry',   // re-read the files and try again
  missing_context:  'retry',   // wider retrieval on the next attempt
  test_failure:     'revert',  // roll back, purge facts, try from clean state
  wrong_approach:   'revert',
  budget_exhausted: 'abort',
};

/** Execute one step, with retries governed by the failure taxonomy. */
async function runOneStep(
  agent: Agent, task: Task, plan: Plan, step: PlanStep,
  pinned: CodeChunk[], rootId: number,
): Promise<boolean> {
  const db = agent.db;
  const stepEventId = db.appendEvent({
    taskId: task.id, parentId: rootId, kind: 'step_start',
    stepId: step.id, payload: { step },
  });
  report(agent, `Step ${step.id}: ${step.intent}`);

  for (let attempt = 1; attempt <= task.budget.maxRetriesPerStep; attempt++) {
    markStep(db, task.id, step, 'running', null, attempt);

    // Snapshot before the attempt: the revert target if it goes wrong.
    const before = await agent.checkpoints.commit('pre-attempt snapshot');
    let problem: string | null = null;

    try {
      const result = await executeStepTurns(agent, task, plan, step, pinned, stepEventId);

      // "Blocked" is the model's claim, not ground truth. Small models often
      // complete the change and then flounder on self-verification (observed
      // live: fixed the bug, then looped trying to run a missing `python`
      // binary until the stuck-detector fired). So if the step touched files,
      // we let mechanical verification judge the work that actually exists;
      // only a step that changed nothing fails on the model's word alone.
      if (result.outcome === 'blocked' && result.filesTouched.length === 0) {
        problem = result.blockedReason ?? 'executor reported it was blocked';
      } else {
        // Mechanical gate: cheap, and it cannot hallucinate a pass.
        const verdict = await verifyChanges(
          agent.projectRoot, result.filesTouched, agent.testCommand);
        db.appendEvent({
          taskId: task.id, parentId: stepEventId, kind: 'verify',
          stepId: step.id, payload: verdict,
          status: verdict.passed ? 'ok' : 'error',
        });

        if (verdict.passed) {
          // Unconditional checkpoint: revert granularity IS checkpoint granularity.
          const sha = await agent.checkpoints.commit(`step ${step.id}: ${step.intent}`);
          db.addFacts(task.id, step.id, result.newFacts);
          agent.retriever.invalidate();
          markStep(db, task.id, step, 'done', sha, attempt);
          db.appendEvent({
            taskId: task.id, parentId: stepEventId, kind: 'step_end',
            stepId: step.id, payload: { outcome: 'done', sha },
          });
          return true;
        }
        problem = [result.blockedReason, ...verdict.problems].filter(Boolean).join('\n');
      }
    } catch (err) {
      problem = err instanceof CallFailedError
        ? `${err.kind}: ${err.message}`
        : (err as Error).message;
    }

    // --- failed: ask diagnose for a label, respond per the taxonomy ---------
    const failureClass = await classifyFailure(
      agent, task, step, problem ?? 'unknown failure', stepEventId);
    report(agent, `Step ${step.id} failed (${failureClass}), attempt ${attempt}`);

    const response = TAXONOMY[failureClass];
    if (response === 'revert') {
      // Roll the tree back AND purge what was learned while it was broken.
      // Doing only the first is how agents poison their own later steps.
      await agent.checkpoints.revertTo(before);
      db.purgeFactsAfter(task.id, step.id);
      db.appendEvent({
        taskId: task.id, parentId: stepEventId, kind: 'checkpoint',
        stepId: step.id, payload: { action: 'revert', to: before, factsPurged: true },
      });
    }
    if (response === 'abort') break;
  }

  markStep(db, task.id, step, 'failed', null, task.budget.maxRetriesPerStep);
  db.appendEvent({
    taskId: task.id, parentId: stepEventId, kind: 'step_end',
    stepId: step.id, payload: { outcome: 'failed' }, status: 'error',
  });
  return false;
}

/**
 * Drive one step's executor turns until it says done, blocks, or loops.
 *
 * The fingerprint check is the stuck-detector: repeating an identical tool
 * call is the signature of a model going in circles, and it is far cheaper to
 * catch here than to let it burn the step's whole turn budget.
 */
async function executeStepTurns(
  agent: Agent, task: Task, plan: Plan, step: PlanStep,
  pinned: CodeChunk[], parentId: number,
): Promise<{
  outcome: 'completed' | 'blocked';
  summary: string;
  filesTouched: string[];
  newFacts: string[];
  blockedReason?: string;
}> {
  const db = agent.db;
  const facts = db.getLiveFacts(task.id);
  const chunks = await agent.retriever.retrieve(
    `${step.intent} ${step.acceptanceCriteria.join(' ')}`, step.targetFiles, 8);
  const projectFiles = await agent.retriever.listPaths();
  const recentOutcomes = db.getSteps(task.id)
    .filter((s) => s.status === 'done').slice(-3)
    .map((s) => `${s.stepId}: ${s.spec.intent} — done`);

  const transcript: string[] = [];
  const filesTouched = new Set<string>();
  const fingerprints = new Map<string, number>();

  for (let turn = 0; turn < MAX_TURNS_PER_STEP; turn++) {
    const { turn: action, eventId } = await executeTurn(
      agent, task, plan, step, facts, chunks, pinned,
      recentOutcomes, transcript, projectFiles, parentId);

    if (action.thought) report(agent, `  ${action.thought}`);

    // Terminal actions end the step.
    if (action.action === 'done' || action.action === 'blocked') {
      return {
        outcome: action.action === 'blocked' ? 'blocked' : 'completed',
        summary: action.summary ?? '',
        filesTouched: [...new Set([...(action.filesTouched ?? []), ...filesTouched])],
        newFacts: action.newFacts ?? [],
        ...(action.blockedReason ? { blockedReason: action.blockedReason } : {}),
      };
    }

    const toolCall = toToolCall(action);
    if (!toolCall) {
      transcript.push(
        `You replied with "${action.action}", which is not a tool. Use one of: ` +
        `read_file, list_files, search_code, write_file, run_command, done, blocked.`);
      continue;
    }

    const fingerprint = JSON.stringify(toolCall);
    const seen = (fingerprints.get(fingerprint) ?? 0) + 1;
    fingerprints.set(fingerprint, seen);
    if (seen >= 3) {
      return {
        outcome: 'blocked',
        summary: 'Repeated the same tool call without making progress.',
        filesTouched: [...filesTouched],
        newFacts: [],
        blockedReason: `Called ${toolCall.name} with identical arguments ${seen} times.`,
      };
    }

    const result = await runTool({
      projectRoot: agent.projectRoot,
      approval: agent.approval,
      onFilesChanged: () => agent.retriever.invalidate(),
    }, toolCall);

    db.appendEvent({
      taskId: task.id, parentId: eventId, kind: 'tool_call',
      stepId: step.id, payload: { call: toolCall, result },
      status: result.ok ? 'ok' : 'error',
    });

    for (const f of result.filesTouched ?? []) filesTouched.add(f);
    transcript.push(
      `${toolCall.name}(${summariseArgs(toolCall.args)}) -> ` +
      `${result.ok ? 'OK' : 'FAILED'}: ${result.output.slice(0, 3000)}`);
  }

  return {
    outcome: 'blocked',
    summary: `Did not finish within ${MAX_TURNS_PER_STEP} turns.`,
    filesTouched: [...filesTouched],
    newFacts: [],
    blockedReason: 'Turn limit reached for this step.',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Ask the diagnose worker for a failure label; fall back to 'transient_api'
 * if diagnosis itself is unavailable (every provider down, say) — treating
 * the failure as transient lets the retry loop do something sensible.
 */
async function classifyFailure(
  agent: Agent, task: Task, step: PlanStep, problem: string, parentId: number,
): Promise<FailureClass> {
  try {
    return await diagnoseFailure(agent, task, step, problem, parentId);
  } catch {
    return 'transient_api';
  }
}

/** Our ceilings — all inside the evaluation's hard limits. */
function checkBudget(
  agent: Agent, task: Task, startedAt: number, stepsRun: number,
): string | null {
  const totals = agent.db.totals(task.id);
  const elapsedSec = (Date.now() - startedAt) / 1000;
  if (totals.costUsd >= task.budget.maxUsd) {
    return `cost ceiling reached ($${totals.costUsd.toFixed(4)})`;
  }
  if (elapsedSec >= task.budget.maxSeconds) {
    return `time ceiling reached (${Math.round(elapsedSec)}s)`;
  }
  if (totals.tokens >= task.budget.maxTokens) {
    return `token ceiling reached (${totals.tokens})`;
  }
  if (stepsRun >= task.budget.maxSteps) {
    return `step ceiling reached (${stepsRun})`;
  }
  return null;
}

function markStep(
  db: Store, taskId: string, step: PlanStep,
  status: StepRecord['status'], sha: string | null, attempts: number,
): void {
  db.upsertStep({ taskId, stepId: step.id, spec: step, status,
                  checkpointSha: sha, attempts });
}

function report(agent: Agent, message: string): void {
  agent.onProgress?.(message);
}

/**
 * Load the user's pinned files/ranges into chunks: tags already stored for
 * this task (resume), plus any @path / @path:12-40 tags in the prompt.
 */
async function loadPins(agent: Agent, task: Task, resuming: boolean): Promise<CodeChunk[]> {
  if (!resuming) {
    for (const tag of parsePinTags(task.prompt)) {
      agent.db.addPin(task.id, tag.path, tag.startLine, tag.endLine);
    }
  }
  const chunks: CodeChunk[] = [];
  for (const pin of agent.db.getPins(task.id)) {
    const chunk = await agent.retriever.readWholeFile(
      pin.path, pin.startLine ?? undefined, pin.endLine ?? undefined);
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

/** Parse `@path`, `@path:12` and `@path:12-40` tags out of a prompt. */
export function parsePinTags(
  prompt: string,
): Array<{ path: string; startLine?: number; endLine?: number }> {
  const out: Array<{ path: string; startLine?: number; endLine?: number }> = [];
  for (const m of prompt.matchAll(/@([A-Za-z0-9_\-./]+?)(?::(\d+)(?:-(\d+))?)?(?=[\s,;)]|$)/g)) {
    const path = m[1]!;
    const start = m[2] ? Number(m[2]) : undefined;
    const end = m[3] ? Number(m[3]) : start;
    out.push({
      path,
      ...(start !== undefined ? { startLine: start, endLine: end } : {}),
    });
  }
  return out;
}

/**
 * Topological order over dependsOn. Falls back to declaration order for
 * anything left over, so a malformed dependency graph degrades to "run it as
 * written" instead of deadlocking.
 */
export function orderSteps(steps: PlanStep[]): PlanStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const done = new Set<string>();
  const out: PlanStep[] = [];

  let progress = true;
  while (progress && out.length < steps.length) {
    progress = false;
    for (const step of steps) {
      if (done.has(step.id)) continue;
      if (step.dependsOn.every((d) => done.has(d) || !byId.has(d))) {
        out.push(step);
        done.add(step.id);
        progress = true;
      }
    }
  }
  for (const step of steps) if (!done.has(step.id)) out.push(step);
  return out;
}

/**
 * Map a flat executor turn onto a tool invocation. The schema is flat because
 * small models cannot reliably nest objects, so reassembling the call is our
 * job. Only the fields the named tool takes are forwarded.
 */
export function toToolCall(action: {
  action: string; path?: string; content?: string; query?: string; command?: string;
}): { name: string; args: Record<string, unknown> } | null {
  switch (action.action) {
    case 'read_file':
    case 'list_files':
      return { name: action.action, args: { path: action.path ?? '.' } };
    case 'search_code':
      return { name: action.action, args: { query: action.query ?? '' } };
    case 'write_file':
      return { name: action.action,
               args: { path: action.path ?? '', content: action.content ?? '' } };
    case 'run_command':
      return { name: action.action, args: { command: action.command ?? '' } };
    default:
      return null;
  }
}

/** Compact argument rendering for the step transcript. */
function summariseArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      // File contents are long and already on disk; the model needs to know
      // the write happened, not to re-read what it wrote.
      return `${k}=${text.length > 60 ? `<${text.length} chars>` : text}`;
    })
    .join(', ');
}
