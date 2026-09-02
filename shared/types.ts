/**
 * The wire contract between the Python server and the React UI.
 *
 * TypeScript, and deliberately so: the UI imports these as types (erased at
 * build time), which is the only way the browser half gets compile-time
 * checking of what the server sends. The Python half mirrors these shapes in
 * `server/agentzero/agent/types.py`, where a `Data` base class emits exactly
 * the camelCase spellings declared here. Change a name in one place and you
 * must change it in the other — this file is the statement of record.
 */

// ---------------------------------------------------------------------------
// Task state, as the UI sees it
// ---------------------------------------------------------------------------

export type TaskStatusWire =
  | 'running' | 'awaiting_review' | 'done' | 'aborted' | 'failed';

export interface TaskSummary {
  id: string;
  /** The chat this task belongs to. */
  conversationId: string;
  prompt: string;
  status: TaskStatusWire;
  complexity: 'easy' | 'medium' | 'hard';
  createdAt: number;
  costUsd: number;
  tokens: number;
  elapsedMs: number;
}

export interface StepWire {
  id: string;
  intent: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  targetFiles: string[];
  difficulty: 'routine' | 'hairy';
  attempts: number;
}

// ---------------------------------------------------------------------------
// Failures, as explained to a human
// ---------------------------------------------------------------------------

/**
 * Why a step or task ended badly, in terms the chat can show directly.
 *
 * This exists because a status of "failed" with no reason is the single worst
 * thing this product can do to a person: the explanation was always in the
 * event log, and nothing surfaced it.
 */
export interface FailureInfo {
  /** The taxonomy label that decided the response. */
  failureClass: string;
  /** The concrete evidence, verbatim: verify output, blocked reason, error text. */
  problem: string;
  /** What the loop did about it. */
  response: 'retry' | 'revert' | 'abort';
  /**
   * Whether the label was decided from evidence we already held, or by
   * spending a model call. Shown so the cost of diagnosis is never invisible.
   */
  decidedBy: 'code' | 'model';
  /** One sentence a person can act on. */
  advice: string;
}

/** Payload of a `step_end` trace node. */
export interface StepEndPayload {
  outcome: 'done' | 'failed' | 'skipped';
  /**
   * For a skipped step: the dependencies that never completed.
   *
   * A skipped step used to leave no event at all — it was marked in the steps
   * table and mentioned in the progress log, so the trace the UI rebuilds
   * from simply had a hole where the step should be, and a task could report
   * fewer steps than it planned with nothing saying where they went.
   */
  blockedBy?: string[];
  sha?: string;
  attempts?: number;
  failure?: FailureInfo;
  /**
   * The agent's own account of what this step did, in its words.
   *
   * The executor has always written this when it finishes a step; it used to
   * be discarded, so the UI could show that a step succeeded but never what
   * it actually accomplished.
   */
  summary?: string;
  /**
   * True when the step was accepted only because what it had already written
   * passed verification, after the executor itself gave up. Kept distinct
   * from a clean finish so nothing claims success on its behalf.
   */
  salvaged?: boolean;
  /** What the step learned and wrote to memory. */
  facts?: string[];
  filesTouched?: string[];
}

/** Payload of a `task_end` trace node. */
export interface TaskEndPayload {
  status: TaskStatusWire;
  stepsCompleted: number;
  stepsTotal: number;
  abortReason?: string | null;
  /**
   * Files the task actually changed. Zero is a real and different outcome
   * from success — completing every step while changing nothing must not
   * send the user to an empty Review pane. Absent on tasks recorded before
   * this was reported.
   */
  changedFiles?: number;
  /** Human-readable outcome line, ready to render. */
  summary: string;
  /** What the user can do next, when the task did not simply succeed. */
  advice?: string;
  /**
   * The agent's closing account of the work, assembled from what it said as
   * it finished each step. Composed in code rather than by another model
   * call: a report of what happened must not itself be able to fail, and the
   * sentences are the model's own either way.
   */
  report?: string;
  /**
   * Addresses the agent reported — a dev server it started. Rendered
   * clickable, because "hand me the localhost port" is a real request whose
   * answer is otherwise buried in a fact table.
   */
  links?: string[];
}

// ---------------------------------------------------------------------------
// Conversations (chats)
// ---------------------------------------------------------------------------

/**
 * One chat: an ordered group of tasks the user considers a single thread of
 * work. A project accumulates many, and the chat panel shows one at a time —
 * "everything this project has ever run" stopped being a conversation and
 * started being an archive at about the fifth task.
 *
 * A conversation is created by the first task sent into it, never by the
 * button that starts it. Pressing "New chat" and then changing your mind
 * therefore leaves nothing behind to clean up.
 */
export interface ConversationWire {
  id: string;
  /** Derived from the first prompt; what the picker lists it under. */
  title: string;
  createdAt: number;
  taskCount: number;
  /** When its newest task started — the order people actually look for. */
  lastActivityAt: number;
}

// ---------------------------------------------------------------------------
// The trace stream (observability dashboard)
// ---------------------------------------------------------------------------

export type TraceKind =
  | 'task_start' | 'task_end' | 'step_start' | 'step_end'
  | 'llm_call' | 'tool_call' | 'route' | 'assemble'
  | 'verify' | 'review' | 'compact' | 'checkpoint' | 'error';

/**
 * One node of the call hierarchy. `parentId` makes this a tree rather than a
 * log. The same rows serve live streaming and post-hoc inspection, so there
 * is no gap between the two modes.
 */
export interface TraceNode {
  id: number;
  parentId: number | null;
  taskId: string;
  seq: number;
  ts: number;
  kind: TraceKind;
  role: string | null;
  stepId: string | null;
  /** Exact input and output for this node. */
  payload: unknown;
  model: string | null;
  provider: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  status: 'ok' | 'error';
}

/** Routing must never be hidden: pushed live as each decision is made. */
export interface RoutingUpdate {
  taskId: string;
  providerId: string;
  modelId: string;
  role: string;
  reason: string;
  runnersUp: Array<{ providerId: string; modelId: string }>;
  estimatedCostUsd: number;
  waitedMs: number;
}

// ---------------------------------------------------------------------------
// Review artifacts (human-in-the-loop diff)
// ---------------------------------------------------------------------------

export interface DiffHunk {
  id: string;
  file: string;
  /** Unified-diff text for this hunk alone. */
  patch: string;
  /** The plan step that produced it — needed to continue around a rejection. */
  stepId: string;
  /** Edits to existing test files are flagged: a green suite the agent
   *  rewrote is not evidence of anything. */
  touchesTests: boolean;
}

export interface ReviewBundle {
  taskId: string;
  hunks: DiffHunk[];
  fullDiff: string;
}

// ---------------------------------------------------------------------------
// Approvals (human gate before side effects)
// ---------------------------------------------------------------------------

/**
 * The human's answer to an approval request.
 *
 * `feedback` is the point: rejecting without saying why leaves the agent to
 * guess, and it usually guesses the same thing again. Guidance is passed
 * through to the model either way — "no, use the existing helper instead" is
 * as useful attached to an approval as to a refusal.
 */
export interface ApprovalDecision {
  eventId: number;
  approved: boolean;
  feedback?: string;
}

export interface ApprovalRequest {
  taskId: string;
  eventId: number;
  toolName: string;
  args: Record<string, unknown>;
  /** Plain-language description of what will change. */
  effect: string;
  /** The exact shell command, verbatim, for run_command. */
  command?: string;
  /** Target path and full proposed contents, for write_file. */
  path?: string;
  content?: string;
}

// ---------------------------------------------------------------------------
// Settings screen
// ---------------------------------------------------------------------------

export interface ProviderInfo {
  providerId: string;
  label: string;
  configured: boolean;
  enabled: boolean;
  preference: 'user' | 'default' | 'floor';
  keyEnv: string | null;
}

export interface ModelInfo {
  providerId: string;
  modelId: string;
  totalParamsB: number;
  /** Citation for the parameter count, so the 80B claim is defensible. */
  paramsSource: string;
  contextTokens: number;
  costPerMTokIn: number;
  costPerMTokOut: number;
  roles: string[];
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
  models: ModelInfo[];
  settingsPath: string;
}

// ---------------------------------------------------------------------------
// /bytheway
// ---------------------------------------------------------------------------

export interface AsideBubble {
  question: string;
  answer: string;
  provider: string;
  model: string;
  costUsd: number;
  ts: number;
}

// ---------------------------------------------------------------------------
// The event envelope pushed over the SSE stream
// ---------------------------------------------------------------------------

type ServerEventBody =
  | { type: 'trace'; node: TraceNode }
  | { type: 'task'; task: TaskSummary }
  | { type: 'steps'; taskId: string; steps: StepWire[] }
  | { type: 'routing'; update: RoutingUpdate }
  | { type: 'approval_request'; request: ApprovalRequest }
  /** An approval no longer needs an answer — stopping the task releases them. */
  | { type: 'approval_resolved'; eventId: number }
  | { type: 'aside'; aside: AsideBubble }
  | { type: 'log'; taskId: string | null; level: 'info' | 'warn' | 'error'; message: string };

/**
 * Every event carries the project it came from.
 *
 * The event bus is one process-wide fan-out, so a task still running in the
 * project you just closed keeps publishing into the same stream as the one
 * you just opened. Without this stamp the browser had no way to tell the two
 * apart, and the old project's task, trace and approvals reappeared in the
 * new project's chat seconds after switching.
 *
 * `projectRoot` is absent on events that genuinely belong to no project — a
 * /bytheway answer, a startup error — and those are shown wherever you are.
 */
export type ServerEvent = ServerEventBody & { projectRoot?: string };
