/**
 * The conversation. Every task in the open chat, in order, with the live one
 * at the bottom — not a single status panel that forgets the moment you send
 * something else.
 *
 * A project holds many chats and shows one. "New chat" is free: it costs
 * nothing and creates nothing until you send into it, so the picker never
 * fills up with empty threads.
 *
 * Composer behaviours:
 *   - a plain message starts a coding task;
 *   - /bytheway <question> is answered in isolation, with zero task context,
 *     and never disturbs a running task;
 *   - clicking code in the file viewer, or clicking an @-reference in a past
 *     message, adds it to the pin tray above the composer as a removable
 *     chip. The tray is the source of truth for what is pinned; sending a
 *     message serialises it into the `@path:12-40` tags the server parses.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  ApprovalRequest, AsideBubble, ConversationWire, StepWire, TaskSummary,
  TraceNode,
} from '../types.ts';
import { api, type TaskRow } from '../api.ts';
import type { LogLine } from '../state.ts';
import { nodesFor, stepsFromTrace } from '../activity.ts';
import { pinLabel, withPinTags, type PinRef } from '../pins.ts';
import { Aside, TaskEntry, type ChatTask, type TaskActions } from './Timeline.tsx';

export function Chat({
  projectRoot, conversationId, conversations, onSelectConversation,
  onRenameConversation,
  task, steps, trace, logs, approvals, asides, history, running,
  onSubmit, onBytheway, onResume, onStop, onApprove, onReview, onRevert, draft, setDraft,
  pins, onRemovePin, onTogglePin, onClearPins,
}: {
  projectRoot: string;
  /** The open chat; null while a new one has not been sent into yet. */
  conversationId: string | null;
  conversations: ConversationWire[];
  onSelectConversation: (id: string | null) => void;
  onRenameConversation: (id: string, title: string) => void;
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
  onStop: (taskId: string) => void;
  onApprove: (eventId: number, approved: boolean, feedback?: string) => void;
  onReview: (taskId: string) => void;
  /**
   * Unlike the other actions, this one resolves: nothing streams a follow-up
   * for a revert the way a resume does, so this component has to know when
   * it is done in order to refetch the trace itself (see `handleRevert`).
   */
  onRevert: (taskId: string, stepId: string) => Promise<void>;
  draft: string;
  setDraft: (value: string) => void;
  /** The active manual-context tray — files/ranges pinned by hand. */
  pins: PinRef[];
  onRemovePin: (pin: PinRef) => void;
  onTogglePin: (pin: PinRef) => void;
  onClearPins: () => void;
}): JSX.Element {
  const [showLog, setShowLog] = useState(false);
  /** Traces fetched on demand for tasks that failed before this page loaded. */
  const [fetched, setFetched] = useState<Record<string, TraceNode[]>>({});
  const [explaining, setExplaining] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  const tasks = useMemo(
    () => buildTasks(history, task, steps, trace, fetched, conversationId),
    [history, task, steps, trace, fetched, conversationId]);

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

  // A revert has no live task streaming its aftermath onto the trace, unlike
  // resume/stop -- so once the server confirms it, pull the trace fresh
  // (same fetch `onExplain` uses) to pick up the step resets it recorded.
  const handleRevert = (taskId: string, stepId: string): void => {
    void onRevert(taskId, stepId)
      .then(() => api.trace(projectRoot, taskId))
      .then((r) => setFetched((f) => ({ ...f, [taskId]: r.events })))
      .catch(() => undefined);       // failure already surfaced by onRevert
  };

  const actions: TaskActions = {
    onApprove,
    onStop,
    onReview,
    onResume,
    onRevert: handleRevert,
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
    onSubmit(withPinTags(text, pins));
    setDraft('');
    onClearPins();
  };

  // Tasks and asides share one timeline, ordered by when they happened.
  const entries = [
    ...tasks.map((t) => ({ ts: t.createdAt, key: `task:${t.id}`, kind: 'task' as const, task: t })),
    ...asides.map((a) => ({ ts: a.ts, key: `aside:${a.ts}`, kind: 'aside' as const, aside: a })),
  ].sort((a, b) => a.ts - b.ts);

  const liveId = task?.id ?? null;

  return (
    <div className="chat">
      <ConversationBar
        conversationId={conversationId}
        conversations={conversations}
        disabled={!projectRoot}
        onSelect={onSelectConversation}
        onRename={onRenameConversation}
      />

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
            {!projectRoot
              ? 'Open a project folder to begin.'
              : conversationId
                ? 'This chat is empty. Describe a change to start it off.'
                : 'New chat. Describe a change — the agent will plan it, carry it out step by step, and show you a diff to review.'}
          </div>
        )}

        {entries.map((entry) => entry.kind === 'aside'
          ? <Aside key={entry.key} aside={entry.aside} />
          : (
            <TaskEntry
              key={entry.key}
              projectRoot={projectRoot}
              task={entry.task}
              approvals={entry.task.id === liveId ? approvals : []}
              actions={actions}
              explaining={explaining === entry.task.id}
              pins={pins}
              onTogglePin={onTogglePin}
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
        {pins.length > 0 && (
          <div className="pin-tray" title="Pinned into this message's context">
            {pins.map((p) => (
              <span key={`${p.path}:${p.startLine ?? ''}-${p.endLine ?? ''}`} className="pin-chip">
                <span className="pin-chip-icon">@</span>
                {pinLabel(p)}
                <button
                  className="pin-chip-remove"
                  title="Remove from context"
                  aria-label={`Unpin ${pinLabel(p)}`}
                  onClick={() => onRemovePin(p)}
                >
                  ×
                </button>
              </span>
            ))}
            <button className="ghost small" onClick={onClearPins} title="Remove all pins">
              clear
            </button>
          </div>
        )}
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
          starting a task · click lines in a file, or an <code>@ref</code> above, to pin/unpin context
        </div>
      </div>
    </div>
  );
}

/**
 * Which chat you are in, and how to get to another one.
 *
 * The list is a popover rather than a permanent sidebar: switching chats is
 * something you do occasionally, and the file tree already owns the left edge
 * of a window that has to fit a diff.
 */
function ConversationBar({
  conversationId, conversations, disabled, onSelect, onRename,
}: {
  conversationId: string | null;
  conversations: ConversationWire[];
  disabled: boolean;
  onSelect: (id: string | null) => void;
  onRename: (id: string, title: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');

  const current = conversations.find((c) => c.id === conversationId) ?? null;

  // Close the popover on any click outside it, the way a menu should.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const commitRename = (): void => {
    const next = title.trim();
    if (current && next && next !== current.title) onRename(current.id, next);
    setRenaming(false);
  };

  return (
    <div className="chat-bar" ref={box}>
      {renaming && current ? (
        <input
          className="chat-title-input"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        <button
          className="chat-title"
          disabled={disabled || !current}
          title={current ? 'Rename this chat' : undefined}
          onClick={() => { setTitle(current?.title ?? ''); setRenaming(true); }}
        >
          {current ? current.title : <span className="muted">New chat</span>}
        </button>
      )}

      <div className="row">
        <button
          className="ghost"
          disabled={disabled || conversationId === null}
          title="Start a fresh chat — nothing is created until you send a message"
          onClick={() => { onSelect(null); setOpen(false); }}
        >
          + New chat
        </button>
        <button
          className="ghost"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
        >
          Previous {open ? '▴' : '▾'}
          {conversations.length > 0 && (
            <span className="muted small">&nbsp;{conversations.length}</span>
          )}
        </button>
      </div>

      {open && (
        <div className="chat-menu">
          {conversations.length === 0 && (
            <div className="muted small pad">
              No earlier chats in this project yet.
            </div>
          )}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`chat-menu-row ${c.id === conversationId ? 'active' : ''}`}
              onClick={() => { onSelect(c.id); setOpen(false); }}
            >
              <span className="chat-menu-title">{c.title}</span>
              <span className="muted small">
                {c.taskCount} task{c.taskCount === 1 ? '' : 's'} · {ago(c.lastActivityAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Coarse on purpose: nobody needs a chat list to the second. */
function ago(ts: number): string {
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 90) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
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
  conversationId: string | null,
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

  // A task running in another chat is still on the event stream — it just
  // does not belong in this one. The header's "running" tag is what says it
  // exists; putting it here would make two chats look like the same chat.
  if (live && live.conversationId === conversationId) {
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
