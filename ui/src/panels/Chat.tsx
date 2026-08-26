/**
 * The conversation surface: what the agent is going to do, where it has got
 * to, and anything it needs from you — with the raw log kept available but
 * out of the way.
 *
 * Two special composer behaviours:
 *   - a message starting with /bytheway is answered as an isolated one-off
 *     question with zero task context, and the running task is untouched;
 *   - @path and @path:12-40 tags (inserted by clicking code in the file
 *     viewer) pin exact files or lines into the agent's context.
 */

import { useEffect, useRef, useState } from 'react';

import type { ApprovalRequest, AsideBubble, StepWire, TaskSummary } from '../types.ts';
import type { TaskRow } from '../api.ts';
import type { LogLine } from '../state.ts';

export function Chat({
  projectRoot, task, steps, logs, approvals, asides, resumable, running,
  onSubmit, onBytheway, onResume, onApprove, draft, setDraft, onReview,
}: {
  projectRoot: string;
  task: TaskSummary | null;
  steps: StepWire[];
  logs: LogLine[];
  approvals: ApprovalRequest[];
  asides: AsideBubble[];
  resumable: TaskRow | null;
  running: boolean;
  onSubmit: (prompt: string) => void;
  onBytheway: (question: string) => void;
  onResume: (taskId: string) => void;
  onApprove: (eventId: number, approved: boolean) => void;
  draft: string;
  setDraft: (value: string) => void;
  onReview: () => void;
}): JSX.Element {
  const [showLog, setShowLog] = useState(false);
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [logs.length, steps.length, approvals.length, asides.length]);

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

  const done = steps.filter((s) => s.status === 'done').length;

  return (
    <div className="chat">
      <div className="chat-scroll">
        {!task && !running && (
          <div className="empty pad">
            {projectRoot
              ? 'Describe a change. The agent will plan it, carry it out step by step, and show you a diff to review.'
              : 'Open a project folder to begin.'}
          </div>
        )}

        {resumable && !running && (
          <div className="bubble">
            <div className="bubble-label">interrupted task</div>
            <div className="muted small">
              “{resumable.prompt.slice(0, 100)}” stopped at{' '}
              {resumable.stepsDone}/{resumable.stepsTotal} steps.
            </div>
            <button className="primary" onClick={() => onResume(resumable.id)}>
              Resume where it left off
            </button>
          </div>
        )}

        {task && (
          <div className="bubble user">
            <div className="bubble-label">you</div>
            {task.prompt || '(resumed task)'}
          </div>
        )}

        {task && (
          <div className="bubble agent">
            <div className="bubble-label">
              agent
              <span className={`tag ${statusTone(task.status)}`}>{task.status}</span>
              <span className="tag">{task.complexity}</span>
            </div>

            {steps.length > 0 ? (
              <>
                <div className="muted small">{done}/{steps.length} steps complete</div>
                <div className="steps">
                  {steps.map((s) => (
                    <div key={s.id} className={`step step-${s.status}`}>
                      <span className="step-mark">{stepMark(s.status)}</span>
                      <span className="step-id">{s.id}</span>
                      <span className="step-intent">{s.intent}</span>
                      {s.difficulty === 'hairy' && <span className="tag warn">hairy</span>}
                      {s.attempts > 1 && <span className="tag">try {s.attempts}</span>}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="muted small">
                {running ? 'Working out a plan…' : 'No plan was produced.'}
              </div>
            )}

            <div className="metrics">
              <span>${task.costUsd.toFixed(5)}</span>
              <span>{task.tokens.toLocaleString()} tokens</span>
              <span>{(task.elapsedMs / 1000).toFixed(0)}s</span>
            </div>

            {task.status === 'awaiting_review' && (
              <button className="primary" onClick={onReview}>
                Review the changes →
              </button>
            )}
          </div>
        )}

        {/* Isolated Q&A, clearly marked as outside the task. */}
        {asides.map((a) => (
          <div key={a.ts} className="bubble aside">
            <div className="bubble-label">
              /bytheway <span className="tag">isolated · no task context</span>
              <span className="model">{a.provider}/{shortModel(a.model)}</span>
            </div>
            <div className="muted small">{a.question}</div>
            <div className="aside-answer">{a.answer}</div>
          </div>
        ))}

        {/* An outstanding approval genuinely blocks the agent, so it is the
            most important thing on screen while it is open. */}
        {approvals.map((a) => (
          <Approval key={a.eventId} request={a} onDecide={(ok) => onApprove(a.eventId, ok)} />
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
              {showLog ? '▾' : '▸'} activity log ({logs.length})
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

        <div ref={logEnd} />
      </div>

      <div className="composer">
        <textarea
          value={draft}
          placeholder={
            !projectRoot ? 'Open a project folder first…'
              : running ? 'A task is running… (/bytheway <question> still works)'
              : 'Describe the change. Click lines in a file to reference exact code, or ask /bytheway <question>.'
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
    </div>
  );
}

function stepMark(status: StepWire['status']): string {
  switch (status) {
    case 'done':    return '✓';
    case 'failed':  return '✕';
    case 'running': return '●';
    case 'skipped': return '–';
    default:        return '○';
  }
}

function statusTone(status: string): string {
  if (status === 'running') return 'warn';
  if (status === 'failed' || status === 'aborted') return 'bad';
  return 'ok';
}

function shortModel(id: string): string {
  const parts = id.split('/');
  return parts[parts.length - 1] ?? id;
}

/**
 * An approval prompt. Shows the exact command, verbatim and unabridged: a
 * paraphrased or truncated command is not something anyone can meaningfully
 * consent to, and this prompt is the only control on what a command may do.
 */
function Approval({
  request, onDecide,
}: {
  request: ApprovalRequest;
  onDecide: (approved: boolean) => void;
}): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const contentLines = (request.content ?? '').split('\n');
  const preview = showAll ? contentLines : contentLines.slice(0, 24);

  return (
    <div className={`approval ${request.command !== undefined ? 'unconfined' : ''}`}>
      <div className="approval-head">Approval needed</div>

      {request.command !== undefined ? (
        <>
          <div className="muted small">This shell command will run:</div>
          <pre className="approval-command">$ {request.command}</pre>
        </>
      ) : request.path !== undefined ? (
        <>
          <div className="approval-effect">
            Write <code>{request.path}</code>
            <span className="muted small"> — {contentLines.length} lines</span>
          </div>
          <pre className="approval-args">
            {preview.map((line, i) => (
              <div key={i}><span className="lineno">{i + 1}</span>{line || ' '}</div>
            ))}
          </pre>
          {contentLines.length > 24 && (
            <button className="ghost" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'show less' : `show all ${contentLines.length} lines`}
            </button>
          )}
        </>
      ) : (
        <pre className="approval-args">
          {JSON.stringify(request.args, null, 2).slice(0, 1500)}
        </pre>
      )}

      {request.command !== undefined && (
        <div className="muted small approval-confinement">
          Runs on your machine. Not restricted to the project — read the command
          above before allowing.
        </div>
      )}

      <div className="row">
        <button className="primary" onClick={() => onDecide(true)}>Allow</button>
        <button className="danger" onClick={() => onDecide(false)}>Reject</button>
      </div>
    </div>
  );
}
