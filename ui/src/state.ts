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
  /**
   * The project this state describes. Every event is checked against it: the
   * server's event bus is one process-wide stream shared by every open
   * project, so a task still running in the folder you just left keeps
   * publishing into it. Without this the old project's task, trace and
   * approvals reappeared in the new project's chat within a second of
   * switching, and the chat looked like it had never changed directory.
   */
  projectRoot: string;
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

const EMPTY: Omit<AppState, 'projectRoot'> = {
  task: null, steps: [], trace: [], routing: [], logs: [], approvals: [],
  asides: [], filesChangedAt: 0,
};

/** A project's state before anything has happened in it. */
export function initialState(projectRoot: string): AppState {
  return { ...EMPTY, projectRoot };
}

export type Action =
  | { type: 'event'; event: ServerEvent }
  | { type: 'project'; projectRoot: string }
  | { type: 'approval_resolved'; eventId: number }
  | { type: 'local_log'; level: LogLine['level']; message: string };

/**
 * Exported for the test suite: which events reach the screen and what
 * survives a change of project is the whole behaviour of this module, and it
 * is decided here, in a pure function, on purpose.
 */
export function reduce(state: AppState, action: Action): AppState {
  if (action.type === 'project') {
    // Opening a different project starts from nothing. Keeping the previous
    // project's timeline while pointing at new files is the bug this fixes.
    return action.projectRoot === state.projectRoot
      ? state
      : { ...EMPTY, projectRoot: action.projectRoot };
  }
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
  // Events with no project belong to no project — a /bytheway answer, a
  // startup error — and are shown wherever you happen to be.
  if (event.projectRoot !== undefined && event.projectRoot !== state.projectRoot) return state;

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
      // A chat/lookup-mode task never plans, so it never earns a 'steps'
      // event to overwrite the last one — without this, its card showed the
      // PREVIOUS task's step chip, done and all, as if it had just re-run.
      return {
        ...state,
        task: event.task,
        steps: event.task.id === state.task?.id ? state.steps : [],
      };
    case 'steps':
      return { ...state, steps: event.steps };
    case 'routing':
      return { ...state, routing: [...state.routing, event.update].slice(-200) };
    case 'approval_request':
      return state.approvals.some((a) => a.eventId === event.request.eventId)
        ? state
        : { ...state, approvals: [...state.approvals, event.request] };
    case 'approval_resolved':
      // The server answered it for us (stopping a task releases anything
      // waiting on a human), so the card must go away on its own.
      return {
        ...state,
        approvals: state.approvals.filter((a) => a.eventId !== event.eventId),
      };
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

export function useAgentStream(projectRoot: string): {
  state: AppState;
  clearApproval: (eventId: number) => void;
  pushLog: (level: LogLine['level'], message: string) => void;
} {
  // Seeded with the project rather than reset into it, so there is no first
  // render during which every incoming event is judged against an empty root.
  const [state, dispatch] = useReducer(reduce, projectRoot, initialState);

  useEffect(() => { dispatch({ type: 'project', projectRoot }); }, [projectRoot]);

  // One subscription for the life of the page: the reducer does the filtering
  // from state, so the callback never closes over a project root that goes
  // stale underneath it.
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
