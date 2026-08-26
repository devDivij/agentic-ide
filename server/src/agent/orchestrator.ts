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
import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ApprovalFn, CodeChunk, FailureClass, Plan, PlanStep, StepRecord, Task,
} from './types.ts';
import type {
  FailureInfo, StepEndPayload, TaskEndPayload,
} from '../shared/types.ts';
import { Store } from './store.ts';
import { Router, BUDGETS, type RouteDecision } from './router.ts';
import { Retriever } from './retrieval.ts';
import { Checkpoints, assertGitAvailable } from './checkpoints.ts';
import { assertLegalCatalogue, PROVIDERS } from './providers.ts';
import { runTool } from './tools.ts';
import { verifyChanges } from './verify.ts';
import { CallFailedError } from './call.ts';
import { TaskCancelledError } from './llm.ts';
import {
  classifyTask, diagnoseFailure, executeTurn, makePlan,
} from './workers.ts';

/** Turns one executor step may take before we call it stuck. */
const MAX_TURNS_PER_STEP = 12;

/**
 * Read-only turns allowed before the loop insists on a change.
 *
 * Small models orient endlessly: one observed run reasoned correctly ("I need
 * to create calculator.js, then start a server") and then opened every single
 * turn with "let me first check the current files", never acting. Retrieval
 * has already put the file list and the relevant code in the window, so four
 * turns of looking is generous.
 */
const EXPLORE_BUDGET = 4;

/** The instruction the loop issues once looking around has stopped paying. */
function mustActNow(turns: number): string {
  return `You have spent ${turns} turns looking without changing anything, and ` +
    `you already have the project's file list and the relevant code above. ` +
    `Your next action MUST be write_file (or start_server if the task asks you ` +
    `to run something, or "done" if the work is already complete, or "blocked" ` +
    `if you genuinely cannot proceed). Do NOT call read_file, list_files or ` +
    `search_code again.`;
}

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
  /**
   * Processes the agent started and left running (dev servers). Held so the
   * owner of the session can stop them; `stopBackground` does that.
   */
  background: ChildProcess[];
  /**
   * Fires when the user asks the task to stop. Checked at every loop
   * boundary and passed to the HTTP layer, so an in-flight model call is
   * aborted rather than waited out — otherwise Stop could take 75 seconds.
   */
  cancel: AbortController;
  /** `cancel.signal`, exposed so the Agent satisfies CallDeps directly. */
  signal: AbortSignal;
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
  const cancel = new AbortController();
  return {
    projectRoot: opts.projectRoot,
    db: new Store(opts.projectRoot),
    router: new Router(new Set(opts.keys.keys()), opts.onRoute),
    keys: opts.keys,
    retriever,
    checkpoints: new Checkpoints(opts.projectRoot),
    projectRules: await readProjectRules(opts.projectRoot),
    approval: opts.approval,
    background: [],
    cancel,
    signal: cancel.signal,
    ...(opts.testCommand ? { testCommand: opts.testCommand } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  };
}

/**
 * Ask a running task to stop.
 *
 * Cooperative, not a kill: the loop finishes what it is safely able to,
 * commits, and returns 'aborted' with the partial diff intact. Everything
 * already written stays on disk and reviewable — a Stop that discarded the
 * work would make people afraid to use it.
 */
export function requestStop(agent: Agent): void {
  agent.cancel.abort();
}

/**
 * Stop anything the agent left running. Called when a session closes, so a
 * task that started a dev server does not leak it for the rest of the day.
 */
export function stopBackground(agent: Agent): void {
  for (const child of agent.background.splice(0)) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
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

    // What the agent said about its own work, gathered from the step events.
    const stepNotes = db.getEvents(task.id)
      .filter((e) => e.kind === 'step_end')
      .map((e) => {
        const p = e.payload as StepEndPayload;
        const spec = steps.find((s) => s.stepId === e.stepId)?.spec;
        return {
          stepId: e.stepId ?? '',
          intent: spec?.intent ?? '',
          ...(p.summary ? { summary: p.summary } : {}),
          facts: p.facts ?? [],
        };
      });
    const salvagedSteps = db.getEvents(task.id)
      .filter((e) => e.kind === 'step_end' && (e.payload as StepEndPayload).salvaged).length;
    const report_ = composeReport(stepNotes);
    // Scan the step notes too, not just facts: the agent reported its server
    // as "GET http://localhost:8000/ returns the page" inside a summary, and
    // a facts-only scan missed the one thing the user actually asked for.
    const links = collectLinks([
      ...stepNotes.map((s) => s.summary ?? ''),
      ...stepNotes.flatMap((s) => s.facts),
      ...db.getLiveFacts(task.id).map((f) => f.text),
    ]);
    const status: Task['status'] = abortReason
      ? 'aborted'
      : done === plan.steps.length ? 'awaiting_review' : 'failed';
    db.setStatus(task.id, status);

    const totals = db.totals(task.id);
    // The outcome is stated in words, once, where the UI can render it. A
    // status of "failed" with no explanation is the worst thing this product
    // can show a person — the reason was always in the log, unsurfaced.
    db.appendEvent({
      taskId: task.id, parentId: rootId, kind: 'task_end',
      payload: {
        status,
        stepsCompleted: done,
        stepsTotal: plan.steps.length,
        abortReason,
        changedFiles: countChangedFiles(diff),
        ...(report_ ? { report: report_ } : {}),
        ...(links.length > 0 ? { links } : {}),
        ...describeOutcome(status, done, plan.steps.length, abortReason, db, task.id,
                           diff.trim().length > 0, salvagedSteps),
      } satisfies TaskEndPayload,
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

    if (agent.cancel.signal.aborted) return 'stopped by you';

    const overBudget = checkBudget(agent, task, startedAt, stepsRun);
    if (overBudget) return overBudget;

    if (!step.dependsOn.every((d) => completed.has(d))) {
      markStep(db, task.id, step, 'skipped', null, 0);
      report(agent, `Skipping ${step.id}: a dependency did not complete`);
      continue;
    }

    stepsRun++;
    let ok: boolean;
    try {
      ok = await runOneStep(agent, task, plan, step, pinned, rootId);
    } catch (err) {
      // A stop is not a failure to diagnose and retry. Unwind to the normal
      // finish: commit, diff, and report 'aborted' with the work intact.
      if (err instanceof TaskCancelledError) return 'stopped by you';
      throw err;
    }
    if (ok) completed.add(step.id);
  }
  return null;
}

/**
 * How the loop responds to each failure class. Something labels the failure;
 * this table decides what to do about it. Keeping the mapping in code is what
 * makes an unreliable model safe to use for a judgement-shaped job.
 */
export const TAXONOMY: Record<FailureClass, 'retry' | 'revert' | 'abort'> = {
  malformed_output: 'retry',   // repair already happened inside callModel
  transient_api:    'retry',   // provider swapped underneath; step untouched
  patch_conflict:   'retry',   // re-read the files and try again
  missing_context:  'retry',   // wider retrieval on the next attempt
  // Fail FORWARD, not back. A red check means something identifiable is
  // wrong with work that mostly exists — reverting deletes the correct files
  // along with the broken one and makes the next attempt redo all of it
  // blind, unable to even see the code that failed. Keeping the tree lets the
  // retry read the failure, read the file, and fix the line.
  test_failure:     'retry',
  // Reverting is for a tree we no longer trust: the model was flailing, so
  // what it left behind is not a foundation to build on.
  wrong_approach:   'revert',
  budget_exhausted: 'abort',
};

/** One sentence a person can act on, per failure class. */
const ADVICE: Record<FailureClass, string> = {
  malformed_output:
    'The model could not produce the required JSON shape. A stronger model for this ' +
    'role, or a smaller step, usually fixes it.',
  transient_api:
    'A provider was unreachable or rate-limited. Configuring a second provider key ' +
    'in Settings gives the router somewhere else to go.',
  patch_conflict:
    'An edit did not apply to the file as it now stands. Re-running usually works ' +
    'once the file is re-read.',
  missing_context:
    'The code needed for this step was never retrieved. Pin the relevant file with ' +
    'an @path tag and try again.',
  test_failure:
    'The change was made but a check went red. The work was kept so it can be ' +
    'repaired rather than redone — the verification output above says what broke.',
  wrong_approach:
    'The model repeated itself without making progress, so the step was rolled back. ' +
    'Re-phrasing this part of the request more concretely is the usual fix.',
  budget_exhausted:
    'A cost, time or step ceiling was reached. Whatever finished is still in the diff.',
};

/**
 * What went wrong, and how we know.
 *
 * `decidedBy` records whether the label came from evidence we already held or
 * from a model call, because diagnosis is not free: in a measured run, six
 * diagnose calls cost 148 of 275 seconds of model time and every one of them
 * failed validation, so the loop silently fell back to a default label. The
 * fix is below in `classifyFailure`.
 */
interface Failure {
  failureClass: FailureClass;
  problem: string;
  decidedBy: 'code' | 'model';
}

/** Evidence the loop already holds by the time a step attempt has failed. */
interface FailureEvidence {
  /** The stuck-detector fired: an identical tool call three times over. */
  looping?: boolean;
  /** The step ran out of turns. */
  turnLimit?: boolean;
  /** A model call failed in a way callModel already classified. */
  callKind?: 'malformed_output' | 'transient_api';
  /** Mechanical verification returned problems. */
  verifyFailed?: boolean;
}

/**
 * Classify a failure from evidence, without a model call where the evidence
 * is unambiguous — which is most of the time.
 *
 * This is the cheap half of "diagnose properly instead of blindly retrying":
 * a loop detected in code IS `wrong_approach` by definition, and a 429 that
 * `callModel` already labelled does not need a second opinion. Returns null
 * only when the executor gave up for a reason it wrote itself, which is the
 * one genuinely ambiguous case.
 */
export function classifyInCode(evidence: FailureEvidence): FailureClass | null {
  if (evidence.looping || evidence.turnLimit) return 'wrong_approach';
  if (evidence.callKind) return evidence.callKind;
  if (evidence.verifyFailed) return 'test_failure';
  return null;
}

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

  // Carried into the next attempt's context so a retry is informed rather
  // than identical. Without this the executor that looped on `list_files`
  // simply looped again, doubling the wall-clock for the same failure.
  let lastFailure: Failure | null = null;

  for (let attempt = 1; attempt <= task.budget.maxRetriesPerStep; attempt++) {
    markStep(db, task.id, step, 'running', null, attempt);

    // Snapshot before the attempt: the revert target if it goes wrong.
    const before = await agent.checkpoints.commit('pre-attempt snapshot');
    let problem: string | null = null;
    const evidence: FailureEvidence = {};

    try {
      const result = await executeStepTurns(
        agent, task, plan, step, pinned, stepEventId,
        attempt > 1 && lastFailure ? retryHint(attempt, lastFailure) : undefined);
      evidence.looping = result.blockedKind === 'looping';
      evidence.turnLimit = result.blockedKind === 'turn_limit';

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
          // A step salvaged from a give-up is not a step completed. Its
          // "summary" is the stuck-detector's complaint, not an account of
          // work, and reporting it as one claims success for a model that
          // quit — the same conflation of "finished" with "did something"
          // that sent a user to an empty Review pane.
          const salvaged = result.outcome === 'blocked';
          const note = salvaged
            ? `Did not finish cleanly (${result.blockedReason ?? 'the executor gave up'}), ` +
              `but what it had already written passes verification.`
            : result.summary;

          markStep(db, task.id, step, 'done', sha, attempt);
          db.appendEvent({
            taskId: task.id, parentId: stepEventId, kind: 'step_end',
            stepId: step.id,
            // Carry the executor's own account forward: it is the only place
            // the system says what it actually did, rather than that it did.
            payload: {
              outcome: 'done', sha, attempts: attempt,
              ...(note ? { summary: note } : {}),
              ...(salvaged ? { salvaged: true } : {}),
              ...(result.newFacts.length > 0 ? { facts: result.newFacts } : {}),
              ...(result.filesTouched.length > 0 ? { filesTouched: result.filesTouched } : {}),
            } satisfies StepEndPayload,
          });
          if (note) report(agent, `  ${salvaged ? '~' : '✓'} ${note}`);
          return true;
        }
        evidence.verifyFailed = true;
        problem = [result.blockedReason, ...verdict.problems].filter(Boolean).join('\n');
      }
    } catch (err) {
      if (err instanceof TaskCancelledError) throw err;   // not ours to handle
      if (err instanceof CallFailedError) evidence.callKind = err.kind;
      problem = err instanceof CallFailedError
        ? `${err.kind}: ${err.message}`
        : (err as Error).message;
    }

    // --- failed: label it, then respond per the taxonomy --------------------
    const failure = await classifyFailure(
      agent, task, step, problem ?? 'unknown failure', evidence, stepEventId);
    lastFailure = failure;
    report(agent,
      `Step ${step.id} failed (${failure.failureClass}, attempt ${attempt}): ` +
      firstLine(failure.problem));

    const response = TAXONOMY[failure.failureClass];
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
    stepId: step.id,
    // The reason travels with the event, so the chat can explain the failure
    // instead of showing a bare ✕ next to a step and leaving the user to guess.
    payload: {
      outcome: 'failed',
      attempts: task.budget.maxRetriesPerStep,
      ...(lastFailure ? { failure: toWireFailure(lastFailure) } : {}),
    } satisfies StepEndPayload,
    status: 'error',
  });
  return false;
}

/**
 * State the outcome in words, plus what the user can do next.
 *
 * Deliberately built from state we already have rather than from a model
 * call: an explanation of a failure must not itself be able to fail.
 */
function describeOutcome(
  status: Task['status'], done: number, total: number,
  abortReason: string | null, db: Store, taskId: string,
  changedAnything: boolean, salvagedSteps: number,
): { summary: string; advice?: string } {
  if (status === 'awaiting_review' && salvagedSteps > 0 && changedAnything) {
    // Every step "passed", but at least one only because its half-finished
    // output happened to parse. Saying "done" here would be a claim the run
    // does not support.
    return {
      summary: `Finished all ${total} step${total === 1 ? '' : 's'}, but ` +
               `${salvagedSteps} did not complete cleanly — the agent stopped early ` +
               `and what it had written was kept because it passes basic checks.`,
      advice: 'Read the diff carefully: this is more likely than usual to be ' +
              'incomplete. Re-running the unfinished part as its own request often ' +
              'works better than one broad instruction.',
    };
  }
  if (status === 'awaiting_review') {
    // "Completed" and "changed something" are different claims, and conflating
    // them sent a user to a Review pane to accept a diff that did not exist.
    // An agent that correctly concludes there is nothing to do has succeeded,
    // but it must say that rather than imply work was done.
    if (!changedAnything) {
      return {
        summary: `Completed all ${total} step${total === 1 ? '' : 's'} without ` +
                 `changing any files — the agent judged the requested change to be ` +
                 `already present.`,
        advice: 'There is nothing to review. If you expected an edit, say more ' +
                'specifically what should differ, and pin the file with an @path tag.',
      };
    }
    return {
      summary: `Done — all ${total} step${total === 1 ? '' : 's'} completed. ` +
               `Review the diff to accept or reject the changes.`,
    };
  }

  if (status === 'aborted') {
    const byUser = abortReason === 'stopped by you';
    return {
      summary: byUser
        ? `Stopped at your request after ${done} of ${total} steps.`
        : `Stopped early after ${done} of ${total} steps: ${abortReason}.`,
      advice: changedAnything
        ? 'Everything finished before the stop is still on disk and in the diff — ' +
          'review it, or resume to carry on from the next unfinished step.'
        : 'Nothing had been changed yet, so nothing was lost.',
    };
  }

  // Failed: name the step that actually broke, and why.
  const failed = db.getSteps(taskId).find((s) => s.status === 'failed');
  const skipped = db.getSteps(taskId).filter((s) => s.status === 'skipped').length;
  const where = failed ? ` at step ${failed.stepId} (${failed.spec.intent})` : '';
  return {
    summary: `Failed${where} after ${done} of ${total} steps completed` +
             (skipped > 0 ? `; ${skipped} later step${skipped === 1 ? '' : 's'} skipped ` +
                            `because they depended on it` : '') + '.',
    advice: done > 0
      ? 'The completed steps are still in the diff — review them, then resume or ' +
        're-phrase the failing part.'
      : 'Nothing was changed. Re-phrasing the request more concretely, or pinning ' +
        'the relevant file with an @path tag, usually helps.',
  };
}

/** How many files a unified diff touches. Zero means there is nothing to review. */
export function countChangedFiles(diff: string): number {
  return (diff.match(/^diff --git /gm) ?? []).length;
}

/**
 * The agent's closing account of the work, in its own words.
 *
 * Assembled in code from what the executor said as it finished each step —
 * no extra model call. Two reasons: a report of what happened must not be
 * able to fail, and the sentences are the model's own regardless, so paying
 * for a second pass would buy phrasing rather than content.
 */
export function composeReport(
  stepNotes: Array<{ stepId: string; intent: string; summary?: string }>,
): string | undefined {
  const told = stepNotes.filter((s) => s.summary?.trim());
  if (told.length === 0) return undefined;
  // One step is the common case: its own sentence is the whole report.
  if (told.length === 1) return told[0]!.summary!.trim();
  return told.map((s) => `• ${s.summary!.trim()}`).join('\n');
}

/** Addresses worth handing back, e.g. a dev server the agent started. */
export function collectLinks(texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const url of text.match(/https?:\/\/[^\s"'<>,)]+/g) ?? []) found.add(url);
  }
  return [...found];
}

function toWireFailure(failure: Failure): FailureInfo {
  return {
    failureClass: failure.failureClass,
    problem: failure.problem,
    response: TAXONOMY[failure.failureClass],
    decidedBy: failure.decidedBy,
    advice: ADVICE[failure.failureClass],
  };
}

/** What the next attempt is told about the last one, so it does not repeat it. */
function retryHint(attempt: number, failure: Failure): string {
  return `Attempt ${attempt - 1} of this step FAILED (${failure.failureClass}):\n` +
    `${failure.problem}\n\n` +
    `Do not repeat that approach. If you were looking around, you have looked ` +
    `enough — make the actual edit with write_file now.`;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? text;
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
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
  pinned: CodeChunk[], parentId: number, retryHint?: string,
): Promise<{
  outcome: 'completed' | 'blocked';
  summary: string;
  filesTouched: string[];
  newFacts: string[];
  blockedReason?: string;
  /**
   * How the step ended, when it ended badly. `looping` and `turn_limit` are
   * decided in code, so they classify the failure without a model call;
   * `model_blocked` is the executor's own claim and is the only case that may
   * need one.
   */
  blockedKind?: 'looping' | 'turn_limit' | 'model_blocked';
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
  /** Consecutive turns spent looking around without changing anything. */
  let exploring = 0;

  for (let turn = 0; turn < MAX_TURNS_PER_STEP; turn++) {
    // Between turns is the cheapest safe place to stop: the last tool call has
    // finished and nothing is half-applied.
    if (agent.cancel.signal.aborted) throw new TaskCancelledError();

    const { turn: action, eventId } = await executeTurn(
      agent, task, plan, step, facts, chunks, pinned,
      recentOutcomes, transcript, projectFiles, parentId, retryHint,
      exploring >= EXPLORE_BUDGET ? mustActNow(exploring) : undefined);

    if (action.thought) report(agent, `  ${action.thought}`);

    // Terminal actions end the step.
    if (action.action === 'done' || action.action === 'blocked') {
      return {
        outcome: action.action === 'blocked' ? 'blocked' : 'completed',
        summary: action.summary ?? '',
        filesTouched: [...new Set([...(action.filesTouched ?? []), ...filesTouched])],
        newFacts: action.newFacts ?? [],
        ...(action.blockedReason ? { blockedReason: action.blockedReason } : {}),
        ...(action.action === 'blocked' ? { blockedKind: 'model_blocked' as const } : {}),
      };
    }

    const toolCall = toToolCall(action);
    if (!toolCall) {
      transcript.push(
        `You replied with "${action.action}", which is not a tool. Use one of: ` +
        `read_file, list_files, search_code, write_file, run_command, ` +
        `start_server, done, blocked.`);
      continue;
    }

    const fingerprint = JSON.stringify(toolCall);
    const seen = (fingerprints.get(fingerprint) ?? 0) + 1;
    fingerprints.set(fingerprint, seen);

    // A repeat that quietly returns the same answer teaches the model nothing
    // — it was the identical, cheerful `index.html style.css` every time that
    // let one run circle until the step died. Refuse instead, in band, where
    // the model is actually looking.
    if (seen === 2) {
      transcript.push(
        `${toolCall.name}(${summariseArgs(toolCall.args)}) -> REFUSED: you already ` +
        `ran this exact call and its result is above. Repeating it changes nothing. ` +
        `Make the actual change now with write_file, or reply "done"/"blocked".`);
      // Jump straight to insisting. A model that repeats itself has already
      // stopped making progress, and the stuck-detector kills the step on the
      // third repeat — which arrived before a turn-counting budget could fire.
      exploring = Math.max(exploring + 1, EXPLORE_BUDGET);
      continue;
    }
    if (seen >= 3) {
      return {
        outcome: 'blocked',
        summary: 'Repeated the same tool call without making progress.',
        filesTouched: [...filesTouched],
        newFacts: [],
        blockedReason:
          `Called ${toolCall.name}(${summariseArgs(toolCall.args)}) with identical ` +
          `arguments ${seen} times without making progress.`,
        blockedKind: 'looping',
      };
    }

    const result = await runTool({
      projectRoot: agent.projectRoot,
      approval: agent.approval,
      onFilesChanged: () => agent.retriever.invalidate(),
      onProcessStarted: (child) => agent.background.push(child),
    }, toolCall);

    db.appendEvent({
      taskId: task.id, parentId: eventId, kind: 'tool_call',
      stepId: step.id, payload: { call: toolCall, result },
      status: result.ok ? 'ok' : 'error',
    });

    // Looking around is only progress until it stops being progress.
    const changedSomething =
      toolCall.name === 'write_file' || toolCall.name === 'start_server';
    exploring = changedSomething ? 0 : exploring + 1;

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
    blockedReason:
      `The step used all ${MAX_TURNS_PER_STEP} of its turns without finishing.`,
    blockedKind: 'turn_limit',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Label a failure — from evidence when we have it, from a model call only
 * when we do not.
 *
 * Measured on a real run before this existed: six diagnose calls cost 148 of
 * 275 seconds of model time, every one failed schema validation (the model
 * wrote its reasoning into `content` and never reached the JSON), and the
 * loop silently fell back to 'transient_api'. So the system spent 54% of its
 * time buying a label it then threw away, and mislabelled every failure.
 *
 * Nearly every failure is already unambiguous by the time we get here: a loop
 * detected in code IS `wrong_approach`, a 429 that callModel already labelled
 * needs no second opinion, a red test suite IS `test_failure`. Only the
 * executor's own "I am blocked because X" is genuinely open to interpretation,
 * and that is the single case that now spends a call.
 */
async function classifyFailure(
  agent: Agent, task: Task, step: PlanStep, problem: string,
  evidence: FailureEvidence, parentId: number,
): Promise<Failure> {
  const known = classifyInCode(evidence);
  if (known) return { failureClass: known, problem, decidedBy: 'code' };

  try {
    const failureClass = await diagnoseFailure(agent, task, step, problem, parentId);
    return { failureClass, problem, decidedBy: 'model' };
  } catch {
    // Diagnosis is a convenience, never a dependency. If it is unavailable,
    // treat the step as a wrong approach: that reverts and re-plans the step
    // with feedback, which is the safer default than retrying identically.
    return { failureClass: 'wrong_approach', problem, decidedBy: 'code' };
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
    case 'start_server':
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
