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
  const [resumable, setResumable] = useState<TaskRow | null>(null);

  const running = state.task?.status === 'running';

  // Re-open the stored project server-side (the authorised set lives in the
  // server process and does not survive its restart), and check whether an
  // interrupted task is waiting to be resumed.
  useEffect(() => {
    if (!projectRoot) { setPicking(true); return; }
    void api.openProject(projectRoot)
      .then(() => refreshResumable(projectRoot))
      .catch((e: Error) => setToast(e.message));
  }, []);

  const refreshResumable = (root: string): void => {
    void api.tasks(root)
      .then((r) => setResumable(r.tasks.find((t) => t.resumable) ?? null))
      .catch(() => setResumable(null));
  };

  const openProject = useCallback((path: string): void => {
    // Tell the server first: opening is what authorises the file endpoints.
    void api.openProject(path)
      .then((r) => {
        setProjectRoot(r.path);
        localStorage.setItem('agentzero.projectRoot', r.path);
        setPicking(false);
        setToast(`Project: ${r.path}`);
        refreshResumable(r.path);
      })
      .catch((e: Error) => setToast(e.message));
  }, []);

  const submit = (prompt: string): void => {
    setResumable(null);
    void api.startTask(projectRoot, prompt).catch((e: Error) => {
      pushLog('error', e.message);
      setToast(e.message);
    });
  };

  const resume = (taskId: string): void => {
    setResumable(null);
    void api.resumeTask(projectRoot, taskId).catch((e: Error) => {
      pushLog('error', e.message);
      setToast(e.message);
    });
  };

  const bytheway = (question: string): void => {
    // The answer arrives on the event stream as an 'aside' bubble.
    void api.bytheway(question).catch((e: Error) => pushLog('error', e.message));
  };

  const approve = (eventId: number, approved: boolean): void => {
    void api.approve(projectRoot, eventId, approved)
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
                  logs={state.logs}
                  approvals={state.approvals}
                  asides={state.asides}
                  resumable={resumable}
                  running={running}
                  onSubmit={submit}
                  onBytheway={bytheway}
                  onResume={resume}
                  onApprove={approve}
                  draft={draft}
                  setDraft={setDraft}
                  onReview={() => setTab('review')}
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
