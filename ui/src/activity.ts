/**
 * Turning the trace stream into something a person can read.
 *
 * Everything here is derived from trace nodes the UI already receives. The
 * information was never missing — "what is it doing right now" and "why did
 * that step fail" were both in the event log from the start, rendered only as
 * a debug tree. These helpers are pure so the components stay dumb.
 *
 * Trace payloads cross the wire as `unknown`, so every reader below narrows
 * defensively: a task recorded before a field existed must degrade to "no
 * detail", never to a crash.
 */

import type {
  FailureInfo, StepEndPayload, StepWire, TaskEndPayload, TraceNode,
} from './types.ts';

// ---------------------------------------------------------------------------
// Narrowing
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** A `step_end` payload, or null if this node predates the shape. */
export function asStepEnd(payload: unknown): StepEndPayload | null {
  if (!isObject(payload)) return null;
  const outcome = payload.outcome;
  if (outcome !== 'done' && outcome !== 'failed') return null;
  return payload as unknown as StepEndPayload;
}

/** A `task_end` payload, or null if this node predates the shape. */
export function asTaskEnd(payload: unknown): TaskEndPayload | null {
  if (!isObject(payload)) return null;
  if (typeof payload.status !== 'string') return null;
  const p = payload as unknown as TaskEndPayload;
  // Older runs recorded status but no summary; synthesise one rather than
  // rendering an empty card.
  return { ...p, summary: str(p.summary) ?? `Task ${p.status}.` };
}

// ---------------------------------------------------------------------------
// Per-task views over the trace
// ---------------------------------------------------------------------------

export function nodesFor(trace: TraceNode[], taskId: string): TraceNode[] {
  return trace.filter((n) => n.taskId === taskId);
}

/** Failure detail per step, for the steps that ended badly. */
export function failuresByStep(nodes: TraceNode[]): Map<string, FailureInfo> {
  const out = new Map<string, FailureInfo>();
  for (const node of nodes) {
    if (node.kind !== 'step_end' || !node.stepId) continue;
    const payload = asStepEnd(node.payload);
    if (payload?.outcome === 'failed' && payload.failure) {
      out.set(node.stepId, payload.failure);
    }
  }
  return out;
}

/**
 * What the agent said it accomplished, per step.
 *
 * The executor writes this every time it finishes a step; showing it is the
 * difference between "step 2 ✓" and "step 2 ✓ — created calculator.js with
 * the four operator functions and started the server on port 8080".
 */
export function notesByStep(nodes: TraceNode[]): Map<string, StepEndPayload> {
  const out = new Map<string, StepEndPayload>();
  for (const node of nodes) {
    if (node.kind !== 'step_end' || !node.stepId) continue;
    const payload = asStepEnd(node.payload);
    if (payload?.outcome === 'done') out.set(node.stepId, payload);
  }
  return out;
}

/** The task's final outcome, once it has one. */
export function taskEndOf(nodes: TraceNode[]): TaskEndPayload | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node && node.kind === 'task_end') return asTaskEnd(node.payload);
  }
  return null;
}

/**
 * Reconstruct the step list from a trace.
 *
 * The live stream pushes steps directly, but a task finished before this page
 * loaded has only its trace — and `step_start` carries the whole step spec,
 * so the plan is recoverable rather than lost on refresh.
 */
export function stepsFromTrace(nodes: TraceNode[]): StepWire[] {
  const byId = new Map<string, StepWire>();
  for (const node of nodes) {
    if (!node.stepId) continue;

    if (node.kind === 'step_start') {
      const spec = isObject(node.payload) && isObject(node.payload.step)
        ? node.payload.step : null;
      byId.set(node.stepId, {
        id: node.stepId,
        intent: (spec && str(spec.intent)) ?? node.stepId,
        status: 'running',
        targetFiles: spec && Array.isArray(spec.targetFiles)
          ? spec.targetFiles.filter((f): f is string => typeof f === 'string') : [],
        difficulty: spec && spec.difficulty === 'hairy' ? 'hairy' : 'routine',
        attempts: 1,
      });
    }

    if (node.kind === 'step_end') {
      const existing = byId.get(node.stepId);
      if (!existing) continue;
      const payload = asStepEnd(node.payload);
      byId.set(node.stepId, {
        ...existing,
        status: payload?.outcome === 'done' ? 'done' : 'failed',
        attempts: payload?.attempts ?? existing.attempts,
      });
    }
  }
  return [...byId.values()];
}

/** Wall-clock a step took, when both ends are recorded. */
export function stepDurations(nodes: TraceNode[]): Map<string, number> {
  const started = new Map<string, number>();
  const out = new Map<string, number>();
  for (const node of nodes) {
    if (!node.stepId) continue;
    if (node.kind === 'step_start') started.set(node.stepId, node.ts);
    if (node.kind === 'step_end') {
      const from = started.get(node.stepId);
      if (from !== undefined) out.set(node.stepId, node.ts - from);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The activity feed
// ---------------------------------------------------------------------------

export interface ActivityLine {
  id: number;
  ts: number;
  text: string;
  tone: 'ok' | 'bad' | 'muted';
}

/**
 * One human sentence for a trace node, or null for nodes not worth a line.
 *
 * `route`, `llm_call` and `assemble` are skipped on purpose: they fire around
 * every single turn and would bury the handful of lines that say what the
 * agent actually did. The in-flight model call is surfaced by
 * `currentActivity` instead, where it belongs.
 */
export function describeNode(node: TraceNode): ActivityLine | null {
  const line = (text: string, tone: ActivityLine['tone'] = 'muted'): ActivityLine =>
    ({ id: node.id, ts: node.ts, text, tone });

  switch (node.kind) {
    case 'tool_call':
      return line(describeTool(node.payload), node.status === 'error' ? 'bad' : 'muted');

    case 'verify': {
      const problems = isObject(node.payload) && Array.isArray(node.payload.problems)
        ? node.payload.problems.length : 0;
      return node.status === 'error'
        ? line(`checks failed${problems ? ` (${problems} problem${problems > 1 ? 's' : ''})` : ''}`, 'bad')
        : line('checks passed', 'ok');
    }

    case 'checkpoint': {
      if (!isObject(node.payload)) return null;
      if (node.payload.action === 'revert') return line('rolled back to the last good state', 'bad');
      const label = str(node.payload.label);
      // The baseline and final snapshots are bookkeeping, not activity.
      return label ? null : line('saved a checkpoint');
    }

    case 'compact':
      return line('compacted the context to fit the window');

    case 'step_start': {
      const step = isObject(node.payload) ? node.payload.step : null;
      const intent = isObject(step) ? str(step.intent) : null;
      return line(`started ${node.stepId ?? 'a step'}${intent ? `: ${intent}` : ''}`);
    }

    case 'step_end': {
      const payload = asStepEnd(node.payload);
      return payload?.outcome === 'done'
        ? line(`finished ${node.stepId ?? 'the step'}`, 'ok')
        : line(`gave up on ${node.stepId ?? 'the step'}`, 'bad');
    }

    case 'error': {
      const message = isObject(node.payload) ? str(node.payload.message) : null;
      const failureClass = isObject(node.payload) ? str(node.payload.failureClass) : null;
      return line(message ?? failureClass ?? 'an error occurred', 'bad');
    }

    default:
      return null;
  }
}

/** A tool call, in the words someone reading over the agent's shoulder would use. */
function describeTool(payload: unknown): string {
  if (!isObject(payload)) return 'used a tool';

  // Retrieval is logged as a pseudo-tool with a different shape.
  if (payload.tool === 'retrieve') {
    const chunks = Array.isArray(payload.chunks) ? payload.chunks.length : 0;
    return `retrieved ${chunks} code chunk${chunks === 1 ? '' : 's'}`;
  }

  const call = isObject(payload.call) ? payload.call : null;
  if (!call) return 'used a tool';

  const args = isObject(call.args) ? call.args : {};
  const path = str(args.path) ?? '';
  const result = isObject(payload.result) ? payload.result : null;
  const failed = result ? result.ok === false : false;

  switch (call.name) {
    case 'read_file':   return `read ${path}`;
    case 'list_files':  return `listed ${path || '.'}`;
    case 'search_code': return `searched for "${str(args.query) ?? ''}"`;
    case 'write_file':  return failed ? `could not write ${path}` : `wrote ${path}`;
    case 'run_command': {
      const command = str(args.command) ?? '';
      return `ran: ${command}${failed ? ' → failed' : ''}`;
    }
    default:            return `${str(call.name) ?? 'tool'}${path ? ` ${path}` : ''}`;
  }
}

/** The last `limit` things the agent did, oldest first. */
export function activityFeed(nodes: TraceNode[], limit = 8): ActivityLine[] {
  const lines: ActivityLine[] = [];
  for (const node of nodes) {
    const line = describeNode(node);
    if (line) lines.push(line);
  }
  return lines.slice(-limit);
}

/**
 * Files a trace node reports having written, if any.
 *
 * The file tree used to go stale the moment the agent created a file: it
 * fetched once per directory change and nothing told it the disk had moved
 * underneath. This is that missing signal, and it is exact — no polling, and
 * no refetch when nothing was written.
 */
export function touchedFiles(node: TraceNode): string[] {
  if (node.kind !== 'tool_call' || !isObject(node.payload)) return [];
  const result = isObject(node.payload.result) ? node.payload.result : null;
  if (!result || result.ok !== true) return [];
  const touched = result.filesTouched;
  return Array.isArray(touched) ? touched.filter((f): f is string => typeof f === 'string') : [];
}

// ---------------------------------------------------------------------------
// What is happening right now
// ---------------------------------------------------------------------------

export interface LiveActivity {
  /** Short verb phrase: "thinking", "working". */
  phase: string;
  /** What it is thinking with, or what it just did. */
  detail: string;
  /** When this phase began, so the caller can show a ticking elapsed time. */
  since: number;
}

/**
 * Infer the current phase from the tail of the trace.
 *
 * The useful signal is that a `route` node is written *before* its model call
 * and the `llm_call` node only after it returns. So a trailing `route` means
 * we are sitting inside a model call right now — which on these models is
 * routinely 25 seconds and was previously indistinguishable from a hang.
 */
export function currentActivity(nodes: TraceNode[]): LiveActivity | null {
  const last = nodes[nodes.length - 1];
  if (!last) return null;

  if (last.kind === 'route') {
    const payload = isObject(last.payload) ? last.payload : {};
    const provider = str(payload.providerId) ?? last.provider ?? '';
    const model = shortModel(str(payload.modelId) ?? last.model ?? '');
    const role = last.role ? `${last.role} · ` : '';
    return {
      phase: 'thinking',
      detail: `${role}${provider}${model ? `/${model}` : ''}`,
      since: last.ts,
    };
  }

  if (last.kind === 'llm_call') {
    return { phase: 'working', detail: 'carrying out the next action', since: last.ts };
  }

  const described = describeNode(last);
  return { phase: 'working', detail: described?.text ?? last.kind, since: last.ts };
}

export function shortModel(id: string): string {
  const parts = id.split('/');
  return parts[parts.length - 1] ?? id;
}
