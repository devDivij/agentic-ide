/**
 * Domain types for the agent runtime. Plain data only — behaviour lives in the
 * module named after it (routing in router.ts, storage in store.ts, ...).
 *
 * Start reading here; every other file builds on these shapes.
 */

// ---------------------------------------------------------------------------
// Roles: the narrow jobs we ask a model to do
// ---------------------------------------------------------------------------

/**
 * "Multi-agent" in this system means several specialised, schema-checked model
 * calls driven by one loop written in code — not autonomous agents talking to
 * each other. A ≤80B model cannot steer itself over a long horizon, so we
 * never ask it to. Each role is one prompt template + one output schema
 * (see workers.ts).
 */
export type Role =
  | 'classify'  // once per task:  how hard is this? sets the budget
  | 'plan'      // once per task:  break the request into steps
  | 'execute'   // many per task:  carry out one step, one tool call at a time
  | 'diagnose'  // on failure:     label WHY it failed (never decides what to do)
  | 'ask';      // /bytheway:      an isolated one-off question, no task state

// ---------------------------------------------------------------------------
// Task, plan, step
// ---------------------------------------------------------------------------

export type Complexity = 'easy' | 'medium' | 'hard';

export type TaskStatus = 'running' | 'awaiting_review' | 'done' | 'aborted' | 'failed';

export interface Task {
  id: string;
  projectRoot: string;
  prompt: string;
  status: TaskStatus;
  complexity: Complexity;
  createdAt: number;
  budget: TaskBudget;
}

/**
 * Ceilings we abort on, not targets we spend up to. All sit well inside the
 * evaluation's hard limits ($0.50 / 2700s → scored zero), so hitting ours
 * still yields a partial diff instead of a disqualified task.
 */
export interface TaskBudget {
  maxUsd: number;
  maxSeconds: number;
  maxTokens: number;
  maxSteps: number;
  maxRetriesPerStep: number;
}

export interface PlanStep {
  id: string;
  /** One sentence: what this step changes. */
  intent: string;
  /** Files the planner expects to touch. Advisory. */
  targetFiles: string[];
  /** How we know the step worked. Fed to verification. */
  acceptanceCriteria: string[];
  /** Ids of earlier steps that must finish first. */
  dependsOn: string[];
  /** Planner's difficulty call — 'hairy' steps route to a stronger model up front. */
  difficulty: 'routine' | 'hairy';
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface StepRecord {
  taskId: string;
  stepId: string;
  spec: PlanStep;
  status: StepStatus;
  /** Shadow-git commit made after this step passed. Our revert point. */
  checkpointSha: string | null;
  attempts: number;
}

// ---------------------------------------------------------------------------
// Facts: the task's durable memory
// ---------------------------------------------------------------------------

/**
 * A one-line claim a step learned, e.g. "tests are run with `pytest -q`".
 * Facts are loaded into later contexts instead of a conversation transcript.
 * Each carries the step that produced it, so reverting a step can also purge
 * everything believed because of it (see store.purgeFactsAfter).
 */
export interface Fact {
  id: number;
  taskId: string;
  text: string;
  stepId: string;
  createdAt: number;
  purgedAt: number | null;
}

// ---------------------------------------------------------------------------
// Failure taxonomy
// ---------------------------------------------------------------------------

/**
 * Every failure the loop knows how to respond to. The diagnose role picks a
 * label from this list; the mapping label → action lives in code
 * (orchestrator.ts TAXONOMY). Small models classify reliably but decide
 * poorly, so we only ever ask them to classify.
 */
export type FailureClass =
  | 'malformed_output'   // reply failed schema validation   → retry (repair already ran)
  | 'transient_api'      // 429/5xx/timeout                  → retry on another provider
  | 'patch_conflict'     // an edit didn't apply             → re-read files, retry
  | 'missing_context'    // needed code was never retrieved  → retry with wider retrieval
  | 'test_failure'       // a check or test went red         → revert + retry clean
  | 'wrong_approach'     // same failure repeating           → revert + retry clean
  | 'budget_exhausted';  // a ceiling was hit                → abort with partial diff

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export interface CodeChunk {
  path: string;
  startLine: number;
  endLine: number;
  /** Line-numbered text, ready to paste into a prompt. */
  text: string;
  /** Why this chunk was selected. Shown in the trace. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Events: the observability substrate
// ---------------------------------------------------------------------------

export type EventKind =
  | 'task_start' | 'task_end'
  | 'step_start' | 'step_end'
  | 'llm_call'   // exact prompt + completion, tokens, cost, model
  | 'tool_call'
  | 'route'      // which model/provider was chosen, and why
  | 'assemble'   // exactly what went into a context window
  | 'verify'
  | 'compact'
  | 'checkpoint'
  | 'error';

/**
 * One node of the trace. `parentId` turns the flat append-only log into the
 * call tree the dashboard renders — the whole observability requirement is
 * queries over this table.
 */
export interface AgentEvent {
  id: number;
  taskId: string;
  parentId: number | null;
  seq: number;
  ts: number;
  kind: EventKind;
  role: Role | null;
  stepId: string | null;
  /** Exact input and output. Never truncated at write time. */
  payload: unknown;
  model: string | null;
  provider: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  status: 'ok' | 'error';
}

/** What appendEvent accepts; the store fills in id/seq/ts and defaults. */
export interface NewEvent {
  taskId: string;
  parentId?: number | null;
  kind: EventKind;
  role?: Role | null;
  stepId?: string | null;
  payload: unknown;
  model?: string | null;
  provider?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
  status?: 'ok' | 'error';
}

// ---------------------------------------------------------------------------
// Tools and approval
// ---------------------------------------------------------------------------

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model. */
  output: string;
  filesTouched?: string[];
}

/**
 * Called before any side-effecting tool runs; resolves with the human's
 * decision. The CLI implements this with a terminal prompt, the web server
 * with a question in the browser, batch runs with () => true.
 */
export type ApprovalFn = (call: ToolCall, description: string) => Promise<boolean>;
