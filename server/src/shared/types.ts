/**
 * Wire types: the contract between the HTTP server and the browser UI.
 *
 * The UI imports ONLY from this file (type-only imports, erased at build
 * time), so the two halves share vocabulary without sharing code. The agent
 * runtime never sees these types — src/web/ translates between the two.
 */

// ---------------------------------------------------------------------------
// Task state, as the UI sees it
// ---------------------------------------------------------------------------

export type TaskStatusWire =
  | 'running' | 'awaiting_review' | 'done' | 'aborted' | 'failed';

export interface TaskSummary {
  id: string;
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
  outcome: 'done' | 'failed';
  sha?: string;
  attempts?: number;
  failure?: FailureInfo;
}

/** Payload of a `task_end` trace node. */
export interface TaskEndPayload {
  status: TaskStatusWire;
  stepsCompleted: number;
  stepsTotal: number;
  abortReason?: string | null;
  /** Human-readable outcome line, ready to render. */
  summary: string;
  /** What the user can do next, when the task did not simply succeed. */
  advice?: string;
}

// ---------------------------------------------------------------------------
// The trace stream (observability dashboard)
// ---------------------------------------------------------------------------

export type TraceKind =
  | 'task_start' | 'task_end' | 'step_start' | 'step_end'
  | 'llm_call' | 'tool_call' | 'route' | 'assemble'
  | 'verify' | 'compact' | 'checkpoint' | 'error';

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

export type ServerEvent =
  | { type: 'trace'; node: TraceNode }
  | { type: 'task'; task: TaskSummary }
  | { type: 'steps'; taskId: string; steps: StepWire[] }
  | { type: 'routing'; update: RoutingUpdate }
  | { type: 'approval_request'; request: ApprovalRequest }
  | { type: 'aside'; aside: AsideBubble }
  | { type: 'log'; taskId: string | null; level: 'info' | 'warn' | 'error'; message: string };
