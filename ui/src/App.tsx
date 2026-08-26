/**
 * Shell layout. The header carries the one piece of state that governs
 * everything else — the open project. It is a button that opens a picker,
 * never a free-text path, and it always shows the folder the agent can
 * actually write to.
 */

import { useCallback, useEffect, useState } from 'react';

import { api, type TaskRow } from './api.ts';
import { useAgentStream } from './state.ts';
import { Chat } from './panels/Chat.tsx';
import { Files } from './panels/Files.tsx';
import { ProjectPicker } from './panels/ProjectPicker.tsx';
import { Review } from './panels/Review.tsx';
import { Routing } from './panels/Routing.tsx';
import { Settings } from './panels/Settings.tsx';
import { Trace } from './panels/Trace.tsx';

type Tab = 'chat' | 'review' | 'routing' | 'trace' | 'settings';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'chat',     label: 'Chat' },
  { id: 'review',   label: 'Review' },
  { id: 'routing',  label: 'Routing' },
  { id: 'trace',    label: 'Trace' },
  { id: 'settings', label: 'Settings' },
];

export function App(): JSX.Element {
  const { state, clearApproval, pushLog } = useAgentStream();
  const [tab, setTab] = useState<Tab>('chat');
  const [picking, setPicking] = useState(false);
  const [projectRoot, setProjectRoot] = useState(
    () => localStorage.getItem('agentzero.projectRoot') ?? '');
  const [draft, setDraft] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  /** Every task this project has run — the chat's conversation history. */
  const [history, setHistory] = useState<TaskRow[]>([]);

  const running = state.task?.status === 'running';

  const refreshHistory = useCallback((root: string): void => {
    void api.tasks(root)
      .then((r) => setHistory(r.tasks))
      .catch(() => setHistory([]));
  }, []);

  // Re-open the stored project server-side: the authorised set lives in the
  // server process and does not survive its restart.
  useEffect(() => {
    if (!projectRoot) { setPicking(true); return; }
    void api.openProject(projectRoot)
      .then(() => refreshHistory(projectRoot))
      .catch((e: Error) => setToast(e.message));
  }, []);

  // A finished task's totals and resumability live server-side; pull them once
  // it stops running so the conversation shows its real final state.
  useEffect(() => {
    if (projectRoot && state.task && state.task.status !== 'running') {
      refreshHistory(projectRoot);
    }
  }, [state.task?.status, state.task?.id, projectRoot, refreshHistory]);

  const openProject = useCallback((path: string): void => {
    // Tell the server first: opening is what authorises the file endpoints.
    void api.openProject(path)
      .then((r) => {
        setProjectRoot(r.path);
        localStorage.setItem('agentzero.projectRoot', r.path);
        setPicking(false);
        setToast(`Project: ${r.path}`);
        refreshHistory(r.path);
      })
      .catch((e: Error) => setToast(e.message));
  }, [refreshHistory]);

  const submit = (prompt: string): void => {
    void api.startTask(projectRoot, prompt).catch((e: Error) => {
      pushLog('error', e.message);
      setToast(e.message);
    });
  };

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
              {t.id === 'review' && state.task?.status === 'awaiting_review' && (
                <span className="badge">•</span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <main>
        {tab === 'settings' ? (
          <Settings />
        ) : (
          <div className="workspace">
            <Files
              projectRoot={projectRoot}
              filesChangedAt={state.filesChangedAt}
              onPin={(ref) => {
                setDraft((d) => (d ? `${d} ${ref}` : ref));
                setTab('chat');
              }}
              onOpenProject={openProject}
            />
            <div className="right">
              {tab === 'chat' && (
                <Chat
                  projectRoot={projectRoot}
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
                  onReview={() => setTab('review')}
                  draft={draft}
                  setDraft={setDraft}
                />
              )}
              {tab === 'review' && (
                <Review
                  projectRoot={projectRoot}
                  taskId={state.task?.id ?? null}
                  onApplied={(message) => { setToast(message); pushLog('info', message); }}
                />
              )}
              {tab === 'routing' && <Routing updates={state.routing} />}
              {tab === 'trace' && <Trace nodes={state.trace} />}
            </div>
          </div>
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
