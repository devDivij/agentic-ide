/**
 * Shell layout. The header carries the one piece of state that governs
 * everything else — the open project. It is a button that opens a picker,
 * never a free-text path, and it always shows the folder the agent can
 * actually write to.
 *
 * Two things here are less obvious than they look:
 *
 *   - Changing the project resets everything downstream of it. The event
 *     stream, the task history and the composer draft all describe one
 *     folder, and carrying any of them into the next one is how the chat
 *     used to look like it had never changed directory at all.
 *   - The chat is one conversation at a time, not the project's whole
 *     archive. Which one is remembered per project, so switching away and
 *     back returns you to the thread you were in rather than to a new one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type TaskRow } from './api.ts';
import type { ConversationWire } from './types.ts';
import { useAgentStream } from './state.ts';
import {
  addPin as addPinTo, removePin as removePinFrom, togglePin as togglePinIn, withPinTags,
  type PinRef,
} from './pins.ts';
import { Chat } from './panels/Chat.tsx';
import { Files } from './panels/Files.tsx';
import { ProjectPicker } from './panels/ProjectPicker.tsx';
import { Routing } from './panels/Routing.tsx';
import { Settings } from './panels/Settings.tsx';
import { Trace } from './panels/Trace.tsx';

type Tab = 'chat' | 'routing' | 'trace' | 'settings';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'chat',     label: 'Chat' },
  { id: 'routing',  label: 'Routing' },
  { id: 'trace',    label: 'Trace' },
  { id: 'settings', label: 'Settings' },
];

/**
 * Which chat is open is remembered per project, never globally: one shared
 * key would carry a foreign conversation id into the next folder, which is
 * the same class of bug as carrying its chat history there.
 */
const conversationKey = (root: string): string => `agentzero.conversation.${root}`;

const readStoredConversation = (root: string): string | null =>
  (root ? localStorage.getItem(conversationKey(root)) : null);

/** Splitter position. One number, shared by every project. */
const WIDTH_KEY = 'agentzero.filesWidth';
const MIN_FILES_WIDTH = 260;
const MIN_CHAT_WIDTH = 380;

export function App(): JSX.Element {
  const [projectRoot, setProjectRoot] = useState(
    () => localStorage.getItem('agentzero.projectRoot') ?? '');
  const { state, clearApproval, pushLog } = useAgentStream(projectRoot);
  const [tab, setTab] = useState<Tab>('chat');
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState('');
  /**
   * Manual context control (spec: files/code blocks must be addable and
   * removable from the active context at any time). This tray is the source
   * of truth for what gets pinned; `draft` stays the free-text message.
   */
  const [pins, setPins] = useState<PinRef[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  /** The chats this project holds, most recently active first. */
  const [conversations, setConversations] = useState<ConversationWire[]>([]);
  /** The open chat. Null means a new one, not yet started by a first task. */
  const [conversationId, setConversationId] = useState<string | null>(
    () => readStoredConversation(localStorage.getItem('agentzero.projectRoot') ?? ''));
  /** The tasks of the open chat — the conversation history. */
  const [history, setHistory] = useState<TaskRow[]>([]);

  const running = state.task?.status === 'running';

  const refreshHistory = useCallback((root: string, chat: string | null): void => {
    void api.tasks(root, chat)
      .then((r) => setHistory(r.tasks))
      .catch(() => setHistory([]));
  }, []);

  const refreshConversations = useCallback((root: string): void => {
    void api.conversations(root)
      .then((r) => setConversations(r.conversations))
      .catch(() => setConversations([]));
  }, []);

  // Re-open the stored project server-side: the authorised set lives in the
  // server process and does not survive its restart.
  useEffect(() => {
    if (!projectRoot) { setPicking(true); return; }
    void api.openProject(projectRoot)
      .then(() => {
        refreshConversations(projectRoot);
        refreshHistory(projectRoot, conversationId);
      })
      .catch((e: Error) => setToast(e.message));
  }, []);

  // A finished task's totals and resumability live server-side; pull them once
  // it stops running so the conversation shows its real final state.
  useEffect(() => {
    if (projectRoot && state.task && state.task.status !== 'running') {
      refreshHistory(projectRoot, conversationId);
      refreshConversations(projectRoot);
    }
  }, [state.task?.status, state.task?.id, projectRoot, conversationId,
      refreshHistory, refreshConversations]);

  const openProject = useCallback((path: string): void => {
    // Tell the server first: opening is what authorises the file endpoints.
    void api.openProject(path)
      .then((r) => {
        const changed = r.path !== projectRoot;
        setProjectRoot(r.path);
        localStorage.setItem('agentzero.projectRoot', r.path);
        setPicking(false);
        setToast(`Project: ${r.path}`);

        // Everything below the project belongs to the project. `useAgentStream`
        // clears the streamed state on its own; these are the pieces App owns.
        const chat = changed ? readStoredConversation(r.path) : conversationId;
        if (changed) {
          setHistory([]);
          setConversations([]);
          setDraft('');          // an @path tag pointing into the old tree
          setPins([]);
          setConversationId(chat);
        }
        refreshConversations(r.path);
        refreshHistory(r.path, chat);
      })
      .catch((e: Error) => setToast(e.message));
  }, [projectRoot, conversationId, refreshHistory, refreshConversations]);

  const selectConversation = useCallback((id: string | null): void => {
    setConversationId(id);
    if (projectRoot) {
      if (id) localStorage.setItem(conversationKey(projectRoot), id);
      else localStorage.removeItem(conversationKey(projectRoot));
    }
    setHistory([]);
    if (projectRoot) refreshHistory(projectRoot, id);
  }, [projectRoot, refreshHistory]);

  const submit = (prompt: string): void => {
    void api.startTask(projectRoot, prompt, conversationId)
      .then((r) => {
        // A new chat only becomes real when its first task starts; this is
        // where the UI learns the id the server gave it.
        if (r.conversationId !== conversationId) {
          setConversationId(r.conversationId);
          localStorage.setItem(conversationKey(projectRoot), r.conversationId);
        }
        refreshConversations(projectRoot);
      })
      .catch((e: Error) => {
        pushLog('error', e.message);
        setToast(e.message);
      });
  };

  const addPin = useCallback((pin: PinRef): void => {
    setPins((prev) => addPinTo(prev, pin));
  }, []);

  const removePin = useCallback((pin: PinRef): void => {
    setPins((prev) => removePinFrom(prev, pin));
  }, []);

  const toggleChatPin = useCallback((pin: PinRef): void => {
    setPins((prev) => togglePinIn(prev, pin));
  }, []);

  const clearPins = useCallback((): void => setPins([]), []);

  const resume = (taskId: string): void => {
    void api.resumeTask(projectRoot, taskId).catch((e: Error) => {
      pushLog('error', e.message);
      setToast(e.message);
    });
  };

  const bytheway = (question: string): void => {
    // The answer arrives on the event stream as an 'aside' bubble.
    void api.bytheway(question).catch((e: Error) => pushLog('error', e.message));
  };

  const stop = (taskId: string): void => {
    void api.stopTask(projectRoot, taskId)
      .then(() => pushLog('info', 'Stop requested — finishing the current step.'))
      .catch((e: Error) => setToast(e.message));
  };

  // Returns a promise (unlike resume/stop above) so Chat.tsx can refetch that
  // task's trace once this actually lands -- nothing streams a follow-up for
  // a revert the way a resume does.
  const revertStep = (taskId: string, stepId: string): Promise<void> =>
    api.revertToStep(projectRoot, taskId, stepId)
      .then((r) => {
        pushLog('info', `Reverted to ${r.revertedTo} — discarded ${r.stepsReset.length} step(s).`);
        refreshHistory(projectRoot, conversationId);
      })
      .catch((e: Error) => { setToast(e.message); throw e; });

  const approve = (eventId: number, approved: boolean, feedback?: string): void => {
    void api.approve(projectRoot, eventId, approved, feedback)
      .then(() => clearApproval(eventId))
      .catch((e: Error) => setToast(e.message));
  };

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const projectName = projectRoot
    ? projectRoot.split('/').filter(Boolean).pop() ?? projectRoot
    : null;

  return (
    <div className="app">
      <header>
        <span className="brand">Agent&nbsp;Zero</span>

        <button
          className="project-button"
          onClick={() => setPicking(true)}
          title={projectRoot || 'No project open'}
        >
          {projectName
            ? <><span className="muted">project</span> <b>{projectName}</b></>
            : <span className="muted">Open a project…</span>}
        </button>

        {running && <span className="tag warn pulse">running</span>}

        <nav>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === 'chat' && state.approvals.length > 0 && (
                <span className="badge">{state.approvals.length}</span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <main>
        {tab === 'settings' ? (
          <Settings />
        ) : (
          <Workspace
            files={
              <Files
                projectRoot={projectRoot}
                filesChangedAt={state.filesChangedAt}
                agentRunning={running}
                onPin={(pin) => {
                  addPin(pin);
                  setTab('chat');
                }}
                onOpenProject={openProject}
                onSaved={(message) => setToast(message)}
              />
            }
          >
            {tab === 'chat' && (
              <Chat
                projectRoot={projectRoot}
                conversationId={conversationId}
                conversations={conversations}
                onSelectConversation={selectConversation}
                onRenameConversation={(id, title) => {
                  void api.renameConversation(projectRoot, id, title)
                    .then(() => refreshConversations(projectRoot))
                    .catch((e: Error) => setToast(e.message));
                }}
                task={state.task}
                steps={state.steps}
                trace={state.trace}
                logs={state.logs}
                approvals={state.approvals}
                asides={state.asides}
                history={history}
                running={running}
                onSubmit={submit}
                onBytheway={bytheway}
                onResume={resume}
                onStop={stop}
                onApprove={approve}
                onRevert={revertStep}
                draft={draft}
                setDraft={setDraft}
                pins={pins}
                onRemovePin={removePin}
                onTogglePin={toggleChatPin}
                onClearPins={clearPins}
              />
            )}
            {tab === 'routing' && <Routing updates={state.routing} />}
            {tab === 'trace' && <Trace nodes={state.trace} />}
          </Workspace>
        )}
      </main>

      {picking && (
        <ProjectPicker
          initialPath={projectRoot}
          onPick={openProject}
          onClose={() => setPicking(false)}
        />
      )}

      {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
    </div>
  );
}

/**
 * The files pane, a draggable divider, and whatever panel is on the right.
 *
 * The width is the files pane's, in pixels, and the chat takes the rest —
 * dragging is a pointer-capture on the divider rather than window-level
 * listeners, so the drag keeps working when the cursor outruns it and needs
 * no cleanup when it ends. Both sides keep a floor: a splitter that can be
 * dragged until one pane is unusable is a way to lose the chat.
 */
function Workspace({
  files, children,
}: {
  files: React.ReactNode; children: React.ReactNode;
}): JSX.Element {
  const shell = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored >= MIN_FILES_WIDTH ? stored : 480;
  });
  const [dragging, setDragging] = useState(false);

  const resize = (clientX: number): void => {
    const box = shell.current?.getBoundingClientRect();
    if (!box) return;
    const max = Math.max(MIN_FILES_WIDTH, box.width - MIN_CHAT_WIDTH);
    const next = Math.min(max, Math.max(MIN_FILES_WIDTH, clientX - box.left));
    setWidth(next);
  };

  return (
    <div className="workspace" ref={shell}>
      <div className="files-pane" style={{ width }}>{files}</div>
      <div
        className={`splitter ${dragging ? 'dragging' : ''}`}
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize · double-click to reset"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => { if (dragging) resize(e.clientX); }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          setDragging(false);
          localStorage.setItem(WIDTH_KEY, String(width));
        }}
        onDoubleClick={() => {
          setWidth(480);
          localStorage.setItem(WIDTH_KEY, '480');
        }}
      />
      <div className="right">{children}</div>
    </div>
  );
}
