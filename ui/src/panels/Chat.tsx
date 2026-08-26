/**
 * The conversation. Every task this project has run, in order, with the live
 * one at the bottom — not a single status panel that forgets the moment you
 * send something else.
 *
 * Composer behaviours:
 *   - a plain message starts a coding task;
 *   - /bytheway <question> is answered in isolation, with zero task context,
 *     and never disturbs a running task;
 *   - @path and @path:12-40 tags (inserted by clicking code in the file
 *     viewer) pin exact files or lines into the agent's context.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  ApprovalRequest, AsideBubble, StepWire, TaskSummary, TraceNode,
} from '../types.ts';
import { api, type TaskRow } from '../api.ts';
import type { LogLine } from '../state.ts';
import { nodesFor, stepsFromTrace } from '../activity.ts';
import { Aside, TaskEntry, type ChatTask, type TaskActions } from './Timeline.tsx';

export function Chat({
  projectRoot, task, steps, trace, logs, approvals, asides, history, running,
  onSubmit, onBytheway, onResume, onApprove, onReview, draft, setDraft,
}: {
  projectRoot: string;
  task: TaskSummary | null;
  steps: StepWire[];
  trace: TraceNode[];
  logs: LogLine[];
  approvals: ApprovalRequest[];
  asides: AsideBubble[];
  /** Every task this project has run, newest last after sorting. */
  history: TaskRow[];
  running: boolean;
  onSubmit: (prompt: string) => void;
  onBytheway: (question: string) => void;
  onResume: (taskId: string) => void;
  onApprove: (eventId: number, approved: boolean) => void;
  onReview: () => void;
  draft: string;
  setDraft: (value: string) => void;
}): JSX.Element {
  const [showLog, setShowLog] = useState(false);
  /** Traces fetched on demand for tasks that failed before this page loaded. */
  const [fetched, setFetched] = useState<Record<string, TraceNode[]>>({});
  const [explaining, setExplaining] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  const tasks = useMemo(
    () => buildTasks(history, task, steps, trace, fetched),
    [history, task, steps, trace, fetched]);

  // Follow the conversation, but never yank the view away from someone who has
  // scrolled up to read something. Starts pinned so opening a project lands on
  // the newest task rather than the oldest.
  const pinnedToBottom = useRef(true);
  useEffect(() => {
    const el = scroll.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [tasks.length, trace.length, approvals.length, asides.length, logs.length]);

  const explain = (taskId: string): void => {
    setExplaining(taskId);
    void api.trace(projectRoot, taskId)
      .then((r) => setFetched((f) => ({ ...f, [taskId]: r.events })))
      .catch(() => undefined)
      .finally(() => setExplaining(null));
  };

  const focusComposer = (text: string): void => {
    setDraft(text);
    composer.current?.focus();
  };

  const actions: TaskActions = {
    onApprove,
    onReview,
    onResume,
    onRetry: focusComposer,
    onAsk: () => focusComposer('/bytheway '),
    onExplain: explain,
  };

  const isAside = draft.trim().startsWith('/bytheway');

  const submit = (): void => {
    const text = draft.trim();
    if (!projectRoot || !text) return;
    if (text.startsWith('/bytheway')) {
      const question = text.replace(/^\/bytheway\s*/, '');
      if (question) { onBytheway(question); setDraft(''); }
      return;
    }
    if (running) return;
    onSubmit(text);
    setDraft('');
  };

  // Tasks and asides share one timeline, ordered by when they happened.
  const entries = [
    ...tasks.map((t) => ({ ts: t.createdAt, key: `task:${t.id}`, kind: 'task' as const, task: t })),
    ...asides.map((a) => ({ ts: a.ts, key: `aside:${a.ts}`, kind: 'aside' as const, aside: a })),
  ].sort((a, b) => a.ts - b.ts);

  const liveId = task?.id ?? null;

  return (
    <div className="chat">
      <div
        className="chat-scroll"
        ref={scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
        }}
      >
        {entries.length === 0 && (
          <div className="empty pad">
            {projectRoot
              ? 'Describe a change. The agent will plan it, carry it out step by step, and show you a diff to review.'
              : 'Open a project folder to begin.'}
          </div>
        )}

        {entries.map((entry) => entry.kind === 'aside'
          ? <Aside key={entry.key} aside={entry.aside} />
          : (
            <TaskEntry
              key={entry.key}
              task={entry.task}
              approvals={entry.task.id === liveId ? approvals : []}
              actions={actions}
              explaining={explaining === entry.task.id}
            />
          ))}

        {logs.some((l) => l.level === 'error') && (
          <div className="bubble error-bubble">
            <div className="bubble-label">errors</div>
            {logs.filter((l) => l.level === 'error').map((l, i) => (
              <div key={i}>{l.message}</div>
            ))}
          </div>
        )}

        {logs.length > 0 && (
          <div className="logbox">
            <button className="ghost" onClick={() => setShowLog((v) => !v)}>
              {showLog ? '▾' : '▸'} raw log ({logs.length})
            </button>
            {showLog && (
              <div className="logs">
                {logs.map((l, i) => (
                  <div key={i} className={`log log-${l.level}`}>{l.message}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="composer">
        <div className="composer-row">
          <textarea
            ref={composer}
            value={draft}
            placeholder={
              !projectRoot ? 'Open a project folder first…'
                : running ? 'A task is running… (/bytheway <question> still works)'
                : 'Describe a change to make — this starts a coding task.'
            }
            disabled={!projectRoot}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
          <button
            className="primary"
            disabled={!projectRoot || !draft.trim() || (running && !isAside)}
            onClick={submit}
          >
            {isAside ? 'Ask aside' : running ? 'Running…' : 'Send'}
          </button>
        </div>
        <div className="composer-hint muted small">
          <b>Ctrl↵</b> to send · <code>/bytheway …</code> asks a question instead of
          starting a task · <code>@file:12-40</code> pins exact code (click lines in a file)
        </div>
      </div>
    </div>
  );
}

/**
 * One entry per task, merging what we know from three places: the project's
 * task list, the live event stream, and any trace we fetched to explain an
 * older failure. The live stream wins — it is the freshest.
 */
function buildTasks(
  history: TaskRow[],
  live: TaskSummary | null,
  liveSteps: StepWire[],
  trace: TraceNode[],
  fetched: Record<string, TraceNode[]>,
): ChatTask[] {
  const byId = new Map<string, ChatTask>();

  for (const row of history) {
    const nodes = pickNodes(row.id, trace, fetched);
    byId.set(row.id, {
      id: row.id,
      prompt: row.prompt,
      status: row.status,
      createdAt: row.createdAt,
      costUsd: row.costUsd,
      tokens: row.tokens,
      elapsedMs: row.elapsedMs,
      stepsDone: row.stepsDone,
      stepsTotal: row.stepsTotal,
      resumable: row.resumable,
      complexity: row.complexity,
      steps: stepsFromTrace(nodes),
      nodes,
      live: false,
    });
  }

  if (live) {
    const nodes = pickNodes(live.id, trace, fetched);
    const previous = byId.get(live.id);
    const steps = liveSteps.length > 0 ? liveSteps : stepsFromTrace(nodes);
    byId.set(live.id, {
      id: live.id,
      prompt: live.prompt || previous?.prompt || '',
      status: live.status,
      createdAt: live.createdAt,
      costUsd: live.costUsd,
      tokens: live.tokens,
      elapsedMs: live.elapsedMs,
      stepsDone: steps.filter((s) => s.status === 'done').length,
      stepsTotal: steps.length,
      resumable: previous?.resumable ?? false,
      complexity: live.complexity,
      steps,
      nodes,
      live: true,
    });
  }

  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function pickNodes(
  taskId: string, trace: TraceNode[], fetched: Record<string, TraceNode[]>,
): TraceNode[] {
  const streamed = nodesFor(trace, taskId);
  return streamed.length > 0 ? streamed : fetched[taskId] ?? [];
}
