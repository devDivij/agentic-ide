/**
 * Client-side view of a task, folded from the event stream. The server
 * streams the same rows the dashboard reads afterwards, so the live and
 * post-hoc views are the same data by construction.
 */

import { useCallback, useEffect, useReducer } from 'react';

import type {
  ApprovalRequest, AsideBubble, RoutingUpdate, ServerEvent, StepWire,
  TaskSummary, TraceNode,
} from './types.ts';
import { subscribe } from './api.ts';
import { touchedFiles } from './activity.ts';

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
  ts: number;
  /** Which task produced this line, so the chat can attribute it. */
  taskId: string | null;
}

export interface AppState {
  task: TaskSummary | null;
  steps: StepWire[];
  trace: TraceNode[];
  routing: RoutingUpdate[];
  logs: LogLine[];
  /** Outstanding approval requests, oldest first. */
  approvals: ApprovalRequest[];
  /** Answered /bytheway questions, in order. */
  asides: AsideBubble[];
  /**
   * Bumped whenever the agent writes a file (and once when a task ends, to
   * catch anything missed). The file tree watches this to refresh itself
   * instead of showing a stale listing.
   */
  filesChangedAt: number;
}

const EMPTY: AppState = {
  task: null, steps: [], trace: [], routing: [], logs: [], approvals: [],
  asides: [], filesChangedAt: 0,
};

type Action =
  | { type: 'event'; event: ServerEvent }
  | { type: 'approval_resolved'; eventId: number }
  | { type: 'local_log'; level: LogLine['level']; message: string };

function reduce(state: AppState, action: Action): AppState {
  if (action.type === 'local_log') {
    // Client-side failures join the same stream as server ones, so the user
    // never has to open a console to find out why nothing happened.
    return { ...state, logs: pushCapped(state.logs, {
      level: action.level, message: action.message, ts: Date.now(), taskId: null }) };
  }
  if (action.type === 'approval_resolved') {
    return { ...state, approvals: state.approvals.filter((a) => a.eventId !== action.eventId) };
  }

  const event = action.event;
  switch (event.type) {
    case 'trace': {
      // The stream replays history on connect, so guard against duplicates.
      if (state.trace.some((n) => n.id === event.node.id)) return state;
      const wrote = touchedFiles(event.node).length > 0;
      const ended = event.node.kind === 'task_end';
      return {
        ...state,
        trace: [...state.trace, event.node],
        ...(wrote || ended ? { filesChangedAt: event.node.ts } : {}),
      };
    }
    case 'task':
      return { ...state, task: event.task };
    case 'steps':
      return { ...state, steps: event.steps };
    case 'routing':
      return { ...state, routing: [...state.routing, event.update].slice(-200) };
    case 'approval_request':
      return state.approvals.some((a) => a.eventId === event.request.eventId)
        ? state
        : { ...state, approvals: [...state.approvals, event.request] };
    case 'aside':
      return state.asides.some((a) => a.ts === event.aside.ts)
        ? state
        : { ...state, asides: [...state.asides, event.aside] };
    case 'log':
      return { ...state, logs: pushCapped(state.logs, {
        level: event.level, message: event.message, ts: Date.now(), taskId: event.taskId }) };
    default:
      return state;
  }
}

function pushCapped(logs: LogLine[], line: LogLine): LogLine[] {
  return [...logs, line].slice(-500);
}

export function useAgentStream(): {
  state: AppState;
  clearApproval: (eventId: number) => void;
  pushLog: (level: LogLine['level'], message: string) => void;
} {
  const [state, dispatch] = useReducer(reduce, EMPTY);

  useEffect(() => subscribe((event) => dispatch({ type: 'event', event })), []);

  return {
    state,
    clearApproval: useCallback(
      (eventId: number) => dispatch({ type: 'approval_resolved', eventId }), []),
    pushLog: useCallback(
      (level: LogLine['level'], message: string) =>
        dispatch({ type: 'local_log', level, message }), []),
  };
}

/** Build the parent→children map the trace tree renders from the flat list. */
export function buildTree(nodes: TraceNode[]): Map<number | null, TraceNode[]> {
  const children = new Map<number | null, TraceNode[]>();
  for (const node of nodes) {
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  }
  return children;
}
