/**
 * The workers: every job we ask a model to do, in one file.
 *
 * Each worker is a prompt + an output schema + one callModel() invocation.
 * "Multi-agent" here means these specialised, independently-validated calls,
 * driven by the orchestrator's loop — never autonomous agents steering each
 * other, which assumes exactly the self-direction a ≤80B model lacks.
 *
 * The output contracts are hand-written examples rather than generated JSON
 * Schemas: small models follow a concrete example far more reliably than a
 * type description. They are rendered LAST in the prompt (see context.ts) and
 * never evicted — validating a reply against a shape the model was never
 * shown guarantees a repair loop.
 */

import { z } from 'zod';

import type {
  CodeChunk, Complexity, Fact, FailureClass, Plan, PlanStep, Task,
} from './types.ts';
import { buildContext } from './context.ts';
import { callModel, type CallDeps } from './call.ts';
import { renderToolCatalog } from './tools.ts';
import { chatComplete } from './llm.ts';
import { coerceTurn } from './parse.ts';
import type { Router } from './router.ts';

/** What every worker needs. The orchestrator's Agent object satisfies this. */
export interface WorkerCtx extends CallDeps {
  projectRules: string | null;
}

// ---------------------------------------------------------------------------
// classify — one cheap call that sets the task's budget and routing bias
// ---------------------------------------------------------------------------

const ClassifySchema = z.object({
  complexity: z.enum(['easy', 'medium', 'hard']),
  reason: z.string().default(''),
});

const CLASSIFY_CONTRACT = `
Reply with ONLY this JSON object and nothing else:
{"complexity": "easy" | "medium" | "hard", "reason": "one short sentence"}

Guidance:
  easy    a single obvious edit in one file
  medium  a few related edits, or one edit that needs looking around first
  hard    several files, or the change is not obvious from the request alone
`.trim();

export async function classifyTask(
  ctx: WorkerCtx, task: Task, parentId: number,
): Promise<{ complexity: Complexity; reason: string }> {
  const { value } = await callModel(ctx, {
    taskId: task.id,
    role: 'classify',
    parentId,
    schema: ClassifySchema,
    // Not 200. These models reason before answering even when told not to —
    // measured, nemotron-3-nano spends ~200 tokens thinking, so a 200-token
    // budget cut it off mid-thought and it never reached the JSON at all.
    // One call per task: the headroom is far cheaper than the repair loop.
    maxTokens: 900,
    // A difficulty label that takes 30s is not slow, it is broken — fail over
    // rather than spend a minute on one word.
    timeoutMs: 30_000,
    // A one-word label gains nothing from deliberation at ~20x the tokens.
    suppressReasoning: true,
    context: buildContext({
      role: 'classify', prompt: task.prompt,
      projectRules: ctx.projectRules, outputContract: CLASSIFY_CONTRACT,
    }),
  });
  return value;
}

// ---------------------------------------------------------------------------
// plan — the one place we deliberately spend on the strongest model:
// a bad plan poisons every downstream token
// ---------------------------------------------------------------------------

const PlanSchema = z.object({
  summary: z.string().default(''),
  steps: z.array(z.object({
    id: z.string().min(1),
    intent: z.string().min(1),
    targetFiles: z.array(z.string()).default([]),
    acceptanceCriteria: z.array(z.string()).default([]),
    dependsOn: z.array(z.string()).default([]),
    difficulty: z.enum(['routine', 'hairy']).default('routine'),
  })).min(1),
});

const PLAN_CONTRACT = `
Reply with ONLY this JSON object and nothing else. Every field is required.

{
  "summary": "one sentence describing the overall change",
  "steps": [
    {
      "id": "s1",
      "intent": "what this step changes, in one sentence",
      "targetFiles": ["<a real path from the file list above>"],
      "acceptanceCriteria": ["how we will know this step worked"],
      "dependsOn": [],
      "difficulty": "routine"
    }
  ]
}

Rules:
  - "targetFiles" MUST contain real paths from the project file list above.
    Never invent a path; if unsure which file, use an empty list [].
  - "id" must be s1, s2, s3 ... in order.
  - "dependsOn" lists ids of EARLIER steps only; [] when there are none.
  - "difficulty" is "routine" or "hairy". Use "hairy" only when the step needs
    real reasoning rather than a mechanical edit.
  - Prefer few steps. One step per file that must change is usually right.
`.trim();

/**
 * Planning that cannot fail the task.
 *
 * A small model sometimes cannot produce a step list at all: observed live,
 * one returned a plan keyed by filename and then twice returned `"steps": []`,
 * which killed the whole task before a single file was touched. But a task
 * with no plan is not a task with no hope — the executor can often just do
 * what was asked. So a planning failure degrades to a one-step plan carrying
 * the user's own request, which is exactly right for simple work and no worse
 * than failing for complex work.
 */
export async function makePlan(
  ctx: WorkerCtx, task: Task, chunks: CodeChunk[], pinned: CodeChunk[],
  projectFiles: string[], parentId: number,
): Promise<Plan> {
  try {
    return await planWithModel(ctx, task, chunks, pinned, projectFiles, parentId);
  } catch (err) {
    ctx.db.appendEvent({
      taskId: task.id, parentId, kind: 'error', role: 'plan',
      payload: {
        failureClass: 'plan_unusable',
        message: (err as Error).message,
        action: 'falling back to a single step carrying the original request',
      },
      status: 'error',
    });
    return singleStepPlan(task);
  }
}

/** The fallback: do what was asked, as one step, and let verification judge it. */
export function singleStepPlan(task: Task): Plan {
  return {
    summary: 'Planning did not produce usable steps; carrying out the request directly.',
    steps: [{
      id: 's1',
      intent: task.prompt,
      targetFiles: [],
      acceptanceCriteria: ['The change the request describes is present and the project still parses.'],
      dependsOn: [],
      // Treated as hard: it is the whole task in one step, so it deserves the
      // strongest model available rather than the cheapest.
      difficulty: 'hairy',
    }],
  };
}

async function planWithModel(
  ctx: WorkerCtx, task: Task, chunks: CodeChunk[], pinned: CodeChunk[],
  projectFiles: string[], parentId: number,
): Promise<Plan> {
  const { value } = await callModel(ctx, {
    taskId: task.id,
    role: 'plan',
    parentId,
    schema: PlanSchema,
    // Generous on purpose: a reasoning model spends most of this thinking,
    // and a plan truncated mid-JSON costs a whole repair cycle. Measured at
    // 2500 the planner used the budget exactly — i.e. it was being clipped.
    maxTokens: 4000,
    difficulty: 'hairy',   // always route planning to the strongest tier
    context: buildContext({
      role: 'plan', prompt: task.prompt,
      projectRules: ctx.projectRules, projectFiles,
      chunks, pinned, outputContract: PLAN_CONTRACT,
    }),
  });
  return normalisePlan(value);
}

/**
 * Make a model-produced plan safe to execute. Three failure modes seen
 * constantly from small models, all cheap to fix and all fatal if left:
 * duplicate ids, dependencies on steps that do not exist, and cycles (any
 * edge pointing forward in a linear list).
 */
export function normalisePlan(plan: Plan): Plan {
  const seen = new Set<string>();
  const steps: PlanStep[] = [];

  for (const [index, step] of plan.steps.entries()) {
    let id = step.id?.trim() || `s${index + 1}`;
    while (seen.has(id)) id = `${id}b`;
    seen.add(id);
    steps.push({ ...step, id });
  }

  const valid = new Set(steps.map((s) => s.id));
  const position = new Map(steps.map((s, i) => [s.id, i]));
  for (const step of steps) {
    step.dependsOn = (step.dependsOn ?? []).filter((d) =>
      valid.has(d) && d !== step.id &&
      (position.get(d) ?? 0) < (position.get(step.id) ?? 0));
    if (step.acceptanceCriteria.length === 0) {
      step.acceptanceCriteria =
        ['The change described in the intent is present and the project still parses.'];
    }
  }
  return { summary: plan.summary, steps };
}

// ---------------------------------------------------------------------------
// execute — one turn: either a tool call or "done"/"blocked".
// The loop that drives turns lives in the orchestrator; this stays pure
// prompt-plus-schema so control flow stays in code.
// ---------------------------------------------------------------------------

/**
 * Deliberately FLAT: given a nested shape ({"toolCall": {"tool": ..., "args":
 * {...}}}) a 30B model reliably flattens it — not as a slip but as its stable
 * idea of the shape, so repair never converges. One level, no unions: an
 * `action` naming a tool or terminal state, arguments as siblings.
 */
export const ExecutorTurnSchema = z.object({
  /** Short reasoning note, surfaced live in the trace. */
  thought: z.string().default(''),
  /** A tool name, or 'done' / 'blocked' to end the step. */
  action: z.string().min(1),
  // Tool arguments, flat. Which ones matter depends on `action`.
  path: z.string().optional(),
  content: z.string().optional(),
  query: z.string().optional(),
  command: z.string().optional(),
  // Terminal-state fields.
  summary: z.string().optional(),
  filesTouched: z.array(z.string()).optional(),
  newFacts: z.array(z.string()).optional(),
  blockedReason: z.string().optional(),
});

export type ExecutorTurn = z.infer<typeof ExecutorTurnSchema>;

const EXECUTE_CONTRACT = `
Reply with ONLY one flat JSON object. Never nest objects inside it.

To use a tool, set "action" to the tool name and put its arguments beside it:
{"thought": "why", "action": "read_file", "path": "calc.py"}
{"thought": "why", "action": "search_code", "query": "multiply"}
{"thought": "why", "action": "list_files", "path": "."}
{"thought": "why", "action": "run_command", "command": "python3 -m pytest -q"}
{"thought": "why", "action": "start_server", "command": "node server.js"}
{"thought": "why", "action": "write_file", "path": "calc.py", "content": "COMPLETE NEW FILE"}

When the step is finished:
{"thought": "why", "action": "done", "summary": "what you changed",
 "filesTouched": ["calc.py"], "newFacts": ["a durable fact worth remembering"]}

When you cannot proceed:
{"thought": "why", "action": "blocked", "blockedReason": "what is missing"}

Rules:
  - "action" is always a plain string. Never an object.
  - Arguments are top-level keys. There is no "args" key.
  - Read a file before rewriting it. "content" must be the COMPLETE new file,
    not a fragment or a diff.
  - Do not repeat a call that already gave you what you needed.
  - To start a server or any process that keeps running, use "start_server",
    never "run_command" - run_command waits for the process to exit.
  - After editing, finish with "done" - do not keep looking around.
`.trim();

export async function executeTurn(
  ctx: WorkerCtx,
  task: Task, plan: Plan, step: PlanStep,
  facts: Fact[], chunks: CodeChunk[], pinned: CodeChunk[],
  recentOutcomes: string[], stepTranscript: string[],
  projectFiles: string[], parentId: number,
  previousAttempt?: string, directive?: string,
): Promise<{ turn: ExecutorTurn; eventId: number }> {
  const { value, eventId } = await callModel(ctx, {
    taskId: task.id,
    role: 'execute',
    parentId,
    stepId: step.id,
    schema: ExecutorTurnSchema,
    coerce: coerceTurn,
    maxTokens: 3000,
    difficulty: step.difficulty,
    context: buildContext({
      role: 'execute', prompt: task.prompt,
      projectRules: ctx.projectRules, projectFiles,
      plan, step, facts, chunks, pinned,
      recentOutcomes, stepTranscript,
      ...(previousAttempt ? { previousAttempt } : {}),
      ...(directive ? { directive } : {}),
      outputContract: `${renderToolCatalog()}\n\n${EXECUTE_CONTRACT}`,
    }),
  });
  return { turn: value, eventId };
}

// ---------------------------------------------------------------------------
// diagnose — label WHY something failed. Never asked what to do about it:
// the label → action mapping lives in the orchestrator's taxonomy table.
// ---------------------------------------------------------------------------

const DiagnosisSchema = z.object({
  failureClass: z.enum([
    'malformed_output', 'transient_api', 'patch_conflict',
    'missing_context', 'test_failure', 'wrong_approach', 'budget_exhausted',
  ]),
  evidence: z.string().default(''),
});

const DIAGNOSE_CONTRACT = `
Reply with ONLY this JSON object and nothing else:
{"failureClass": "<one of the labels below>", "evidence": "one short sentence"}

Labels:
  malformed_output  the model's own reply was not valid for the required shape
  transient_api     a network or provider error; nothing was actually attempted
  patch_conflict    an edit did not apply to the file as it now stands
  missing_context   the code needed to do this was never provided
  test_failure      the change was made but a check or test went red
  wrong_approach    the same failure keeps repeating; the plan step is wrong
  budget_exhausted  a time, token or cost ceiling was reached

Choose the single closest label. Do not propose a fix - that is not your job.
`.trim();

export async function diagnoseFailure(
  ctx: WorkerCtx, task: Task, step: PlanStep, problem: string, parentId: number,
): Promise<FailureClass> {
  const { value } = await callModel(ctx, {
    taskId: task.id,
    role: 'diagnose',
    parentId,
    stepId: step.id,
    schema: DiagnosisSchema,
    // Picking one label from seven is classification, so we ask for no
    // reasoning — but budget as if the model ignores us, because some do.
    // Measured: a model that disregards `/no_think` spent all 400 tokens of
    // an earlier budget thinking, never reached the JSON, and burned three
    // calls (~25s) failing validation. Room to think and answer is far
    // cheaper than a repair loop that cannot converge.
    maxTokens: 1200,
    suppressReasoning: true,
    timeoutMs: 40_000,
    context: buildContext({
      role: 'diagnose', prompt: task.prompt,
      projectRules: ctx.projectRules,
      recentOutcomes: [`The step failed with:\n${problem}`],
      outputContract: DIAGNOSE_CONTRACT,
    }),
  });
  return value.failureClass;
}

// ---------------------------------------------------------------------------
// ask — /bytheway: one isolated question with ZERO task state.
// ---------------------------------------------------------------------------

export interface AsideAnswer {
  answer: string;
  provider: string;
  model: string;
  costUsd: number;
  durationMs: number;
}

/**
 * Answers a one-off question in the same chat without touching the running
 * task. Isolation is structural: this function receives no task, no store and
 * no facts, so it physically cannot leak task context in — or pollute it.
 * It still goes through the router, so the call is rate-limited, transparent
 * and free-tier-first like everything else.
 */
export async function askAside(
  router: Router, keys: Map<string, string>, question: string,
): Promise<AsideAnswer> {
  const route = await router.pick({ role: 'ask', estimatedTokens: question.length / 4 + 200 });
  const result = await chatComplete(route.providerId, route.modelId, {
    messages: [
      { role: 'system', content: 'You are a concise, accurate programming assistant.' },
      { role: 'user', content: question },
    ],
    maxTokens: 1200,
  }, keys);
  router.recordUsage(route.providerId, result.tokensIn + result.tokensOut);
  return {
    answer: result.text,
    provider: result.provider,
    model: result.model,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
  };
}
