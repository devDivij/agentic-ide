/**
 * The pieces the chat timeline is built from.
 *
 * Chat.tsx decides what goes in what order; everything here just renders one
 * entry. The guiding rule after watching a real run go wrong: never show a
 * state without its reason. A ✕ with no explanation is worse than no ✕.
 */

import { useEffect, useMemo, useReducer, useState } from 'react';

import type {
  ApprovalRequest, AsideBubble, FailureInfo, StepEndPayload, StepWire,
  TaskEndPayload, TraceNode,
} from '../types.ts';
import {
  activityFeed, currentActivity, failuresByStep, notesByStep, shortModel,
  stepDurations, taskEndOf,
} from '../activity.ts';
import { api } from '../api.ts';
import { diffFiles } from '../diff.ts';
import { DiffLines } from './DiffLines.tsx';

/** One task in the conversation, whether it is live, finished, or historical. */
export interface ChatTask {
  id: string;
  prompt: string;
  status: string;
  createdAt: number;
  costUsd: number;
  tokens: number;
  elapsedMs: number;
  stepsDone: number;
  stepsTotal: number;
  resumable: boolean;
  complexity?: string;
  /** Steps, when known: streamed live, or recovered from a fetched trace. */
  steps: StepWire[];
  /** Trace nodes for this task, when we hold them. */
  nodes: TraceNode[];
  /** True for the task currently streaming into this page. */
  live: boolean;
}

export interface TaskActions {
  /** `feedback` is optional guidance, passed on whether or not it was allowed. */
  onApprove: (eventId: number, approved: boolean, feedback?: string) => void;
  onReview: () => void;
  onResume: (taskId: string) => void;
  onRetry: (prompt: string) => void;
  onAsk: (prompt: string) => void;
  onExplain: (taskId: string) => void;
  onStop: (taskId: string) => void;
}

/** Re-render on a timer, so an elapsed counter actually counts. */
function useTick(active: boolean, everyMs = 500): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(bump, everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
}

// ---------------------------------------------------------------------------
// A task: the prompt that started it, and everything that came of it
// ---------------------------------------------------------------------------

export function TaskEntry({
  projectRoot, task, approvals, actions, explaining,
}: {
  /** Needed only to diff a proposed write against what is on disk now. */
  projectRoot: string;
  task: ChatTask;
  approvals: ApprovalRequest[];
  actions: TaskActions;
  explaining: boolean;
}): JSX.Element {
  const running = task.live && task.status === 'running';
  useTick(running);

  // Cleared implicitly: once the task ends, `running` goes false and the whole
  // activity strip unmounts along with this state.
  const [stopping, setStopping] = useState(false);

  const failures = failuresByStep(task.nodes);
  const notes = notesByStep(task.nodes);
  const durations = stepDurations(task.nodes);
  const end = taskEndOf(task.nodes);
  const elapsed = running ? Date.now() - task.createdAt : task.elapsedMs;

  // TRIAGE's chat lane (orchestrator.ts, mode === 'chat'): finished with no
  // plan at all. `status === 'done'` reached directly (not via HITL accept)
  // combines with zero steps only on this path — a task-mode run is always
  // 'awaiting_review' first, and PlanSchema forbids an empty step list — so
  // this pair is a safe, if implicit, signal without a dedicated wire field.
  // Rendered like a plain conversation turn: no status chip, no step list,
  // no outcome box with buttons that only make sense for a considered edit.
  if (task.status === 'done' && task.steps.length === 0) {
    return (
      <>
        <div className="bubble user">
          <div className="bubble-label">you</div>
          {task.prompt || <span className="muted">(resumed task)</span>}
        </div>
        <div className="bubble agent">
          <div className="bubble-label">agent</div>
          <div className="aside-answer">{end?.summary}</div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="bubble user">
        <div className="bubble-label">you</div>
        {task.prompt || <span className="muted">(resumed task)</span>}
      </div>

      <div className="bubble agent">
        <div className="bubble-label">
          agent
          <span className={`tag ${statusTone(task.status)}`}>{task.status.replace('_', ' ')}</span>
          {task.complexity && <span className="tag">{task.complexity}</span>}
        </div>

        {task.steps.length > 0 ? (
          <div className="steps">
            {task.steps.map((s) => (
              <Step
                key={s.id}
                step={s}
                durationMs={durations.get(s.id)}
                failure={failures.get(s.id)}
                note={notes.get(s.id)}
              />
            ))}
          </div>
        ) : (
          <div className="muted small">
            {/* True before classify resolves mode — could still turn out to
                be a chat reply with no plan at all, so this stays neutral. */}
            {running ? 'Thinking…' : 'No plan was produced.'}
          </div>
        )}

        {running && (
          <ActivityStrip
            nodes={task.nodes}
            stopping={stopping}
            onStop={() => { setStopping(true); actions.onStop(task.id); }}
          />
        )}

        <div className="metrics">
          <span>${task.costUsd.toFixed(5)}</span>
          <span>{task.tokens.toLocaleString()} tokens</span>
          <span title={task.live ? 'wall clock' : 'time spent in model calls'}>
            {(elapsed / 1000).toFixed(0)}s
          </span>
          {task.steps.length > 0 && (
            <span>{task.stepsDone}/{task.stepsTotal} steps</span>
          )}
        </div>

        {/* Only offer the Review pane when there is something in it. A task
            can complete every step and change nothing — the agent judging
            that the requested change is already present is a real outcome,
            and sending someone to review an empty diff reads as a bug. */}
        {task.status === 'awaiting_review' && end?.changedFiles !== 0 && (
          <button className="primary" onClick={actions.onReview}>
            Review the changes →
          </button>
        )}

        {/* Every finished task states how it ended, not just the bad ones. */}
        {end && <Outcome end={end} task={task} actions={actions} />}

        {/* Left mid-flight by a crash or a restart: the plan and every finished
            step are still on disk, so this picks up where it stopped. */}
        {task.resumable && !running && (
          <div className="outcome">
            <div className="outcome-summary">This task was interrupted.</div>
            <div className="outcome-advice">
              {task.stepsDone} of {task.stepsTotal || '?'} steps had finished. Resuming
              continues from the first unfinished step against the original baseline.
            </div>
            <div className="row outcome-actions">
              <button className="primary" onClick={() => actions.onResume(task.id)}>
                Resume
              </button>
            </div>
          </div>
        )}

        {/* A task that failed before this page loaded has its explanation on
            disk but not in memory. Offer to go and get it. */}
        {!end && !running && isBad(task.status) && task.nodes.length === 0 && (
          <button
            className="ghost"
            disabled={explaining}
            onClick={() => actions.onExplain(task.id)}
          >
            {explaining ? 'loading…' : 'why did this fail?'}
          </button>
        )}
      </div>

      {approvals.map((a) => (
        <Approval
          key={a.eventId}
          projectRoot={projectRoot}
          request={a}
          onDecide={(ok, feedback) => actions.onApprove(a.eventId, ok, feedback)}
        />
      ))}
    </>
  );
}

function Step({
  step, durationMs, failure, note,
}: {
  step: StepWire;
  durationMs: number | undefined;
  failure: FailureInfo | undefined;
  note: StepEndPayload | undefined;
}): JSX.Element {
  return (
    <div className="step-block">
      <div className={`step step-${step.status}`}>
        <span className="step-mark">{stepMark(step.status)}</span>
        <span className="step-id">{step.id}</span>
        <span className="step-intent">{step.intent}</span>
        {step.difficulty === 'hairy' && <span className="tag warn">hairy</span>}
        {step.attempts > 1 && <span className="tag">try {step.attempts}</span>}
        {durationMs !== undefined && (
          <span className="muted small">{(durationMs / 1000).toFixed(0)}s</span>
        )}
      </div>

      {/* What the agent says it actually did — the note it writes on finishing
          a step, which used to be discarded. */}
      {note?.summary && <div className="step-note">{note.summary}</div>}
      {note?.filesTouched && note.filesTouched.length > 0 && (
        <div className="step-files muted small">
          {note.filesTouched.map((f) => <code key={f}>{f}</code>)}
        </div>
      )}

      {failure && <Failure failure={failure} />}
    </div>
  );
}

/** Why a step failed, in full. This is the thing whose absence made a run unreadable. */
function Failure({ failure }: { failure: FailureInfo }): JSX.Element {
  return (
    <div className="failure">
      <div className="failure-head">
        <span className="tag bad">{failure.failureClass.replace(/_/g, ' ')}</span>
        <span className="tag">{failure.response}</span>
        <span className="muted small" title="Whether a model call was spent deciding this">
          diagnosed in {failure.decidedBy}
        </span>
      </div>
      {failure.problem && <pre className="failure-problem">{failure.problem}</pre>}
      {failure.advice && <div className="failure-advice">{failure.advice}</div>}
    </div>
  );
}

/** What happened overall, and what the person can do about it. */
function Outcome({
  end, task, actions,
}: {
  end: TaskEndPayload; task: ChatTask; actions: TaskActions;
}): JSX.Element {
  return (
    <div className="outcome">
      {/* The agent's own closing account comes first: it is what a person
          actually wants to read, and the status line is context for it. */}
      {end.report && <div className="outcome-report">{end.report}</div>}

      {end.links && end.links.length > 0 && (
        <div className="outcome-links">
          {end.links.map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer">{url}</a>
          ))}
        </div>
      )}

      <div className="outcome-summary">{end.summary}</div>
      {end.abortReason && <div className="muted small">{end.abortReason}</div>}
      {end.advice && <div className="outcome-advice">{end.advice}</div>}
      <div className="row outcome-actions">
        {task.resumable && (
          <button className="primary" onClick={() => actions.onResume(task.id)}>
            Resume
          </button>
        )}
        {/* Never offer a review of nothing: changedFiles === 0 is a definite
            "the diff is empty", while undefined means an older task that
            never reported it, where offering is the safer guess. */}
        {end.stepsCompleted > 0 && end.changedFiles !== 0 && (
          <button onClick={actions.onReview}>
            {end.status === 'awaiting_review' ? 'Review the changes' : 'Review partial changes'}
          </button>
        )}
        {task.prompt && (
          <button onClick={() => actions.onRetry(task.prompt)}>
            {end.changedFiles === 0 ? 'Ask for something more specific' : 'Try again'}
          </button>
        )}
        <button className="ghost" onClick={() => actions.onAsk(task.prompt)}>
          Ask about this
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live activity
// ---------------------------------------------------------------------------

/**
 * What the agent is doing right now, and what it just did.
 *
 * A single model call on these models routinely takes 25 seconds and has been
 * seen to take 100. Without a running counter that is indistinguishable from
 * a hang, which is exactly how a working run came to look broken.
 */
function ActivityStrip({
  nodes, stopping, onStop,
}: {
  nodes: TraceNode[];
  stopping: boolean;
  onStop: () => void;
}): JSX.Element {
  const now = currentActivity(nodes);
  const feed = activityFeed(nodes);

  return (
    <div className="activity">
      <div className="activity-now">
        <span className="activity-what">
          <span className="spinner" />
          {now ? (
            <>
              <b>{now.phase}</b>
              <span className="muted">{now.detail}</span>
            </>
          ) : (
            <span className="muted">working…</span>
          )}
        </span>
        {now && (
          <span className="activity-elapsed">
            {Math.max(0, Math.round((Date.now() - now.since) / 1000))}s
          </span>
        )}
        {/* Stopping is not instant — the loop finishes the step it is in.
            Saying so is what stops people clicking it repeatedly. */}
        <button
          className="danger activity-stop"
          disabled={stopping}
          title="Stop after the current step; everything changed so far is kept"
          onClick={onStop}
        >
          {stopping ? 'stopping…' : 'Stop'}
        </button>
      </div>
      {feed.length > 0 && (
        <div className="activity-feed">
          {feed.map((line) => (
            <div key={line.id} className={`activity-line tone-${line.tone}`}>
              {line.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Asides and approvals
// ---------------------------------------------------------------------------

export function Aside({ aside }: { aside: AsideBubble }): JSX.Element {
  return (
    <div className="bubble aside">
      <div className="bubble-label">
        /bytheway <span className="tag">isolated · no task context</span>
        <span className="model">{aside.provider}/{shortModel(aside.model)}</span>
      </div>
      <div className="muted small">{aside.question}</div>
      <div className="aside-answer">{aside.answer}</div>
    </div>
  );
}

/**
 * An approval prompt. Shows the exact command, verbatim and unabridged: a
 * paraphrased or truncated command is not something anyone can meaningfully
 * consent to, and this prompt is the only control on what a command may do.
 *
 * A proposed write is shown as a diff against what is actually on disk, not
 * as a wall of the new content: the question this prompt answers is "what is
 * about to change", and a plain listing of 25 lines answers a different,
 * less useful question when only one of them is new.
 */
export function Approval({
  projectRoot, request, onDecide,
}: {
  projectRoot: string;
  request: ApprovalRequest;
  onDecide: (approved: boolean, feedback?: string) => void;
}): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const [note, setNote] = useState('');
  const decide = (approved: boolean): void => onDecide(approved, note.trim() || undefined);

  return (
    <div className={`approval ${request.command !== undefined ? 'unconfined' : ''}`}>
      <div className="approval-head">Approval needed</div>

      {request.command !== undefined ? (
        <>
          <div className="muted small">This shell command will run:</div>
          <pre className="approval-command">$ {request.command}</pre>
        </>
      ) : request.path !== undefined ? (
        <WriteDiff
          projectRoot={projectRoot}
          path={request.path}
          proposed={request.content ?? ''}
          showAll={showAll}
          onShowAll={() => setShowAll((v) => !v)}
        />
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

      {/* Optional, and it must stay optional: most approvals are one click.
          But a bare "no" tells the agent nothing, so it tends to propose the
          same thing again — a sentence here redirects it in one turn. */}
      <textarea
        className="approval-note"
        value={note}
        placeholder="optional: tell the agent what to do instead"
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) decide(true);
          // Escape clears the box rather than deciding: a stray keypress must
          // never approve or reject something on the user's behalf.
          if (e.key === 'Escape') { e.stopPropagation(); setNote(''); }
        }}
      />

      <div className="row">
        <button className="primary" onClick={() => decide(true)}>Allow</button>
        <button className="danger" onClick={() => decide(false)}>Reject</button>
        {note.trim() && (
          <span className="muted small">sent with your decision</span>
        )}
      </div>
    </div>
  );
}

/**
 * The proposed content, diffed against what is on disk right now.
 *
 * Fetched once per approval (keyed on `path` — a fresh approval on the same
 * path re-fetches, since the file may have moved since the last one). A
 * missing file is not an error here: it means this write creates the file,
 * so every line is shown added and nothing is fetched a second time to find
 * that out.
 */
function WriteDiff({
  projectRoot, path, proposed, showAll, onShowAll,
}: {
  projectRoot: string;
  path: string;
  proposed: string;
  showAll: boolean;
  onShowAll: () => void;
}): JSX.Element {
  const [existing, setExisting] = useState<{ path: string; content: string | null } | null>(null);

  useEffect(() => {
    let live = true;
    setExisting(null);
    api.readFile(projectRoot, path)
      .then((f) => { if (live) setExisting({ path, content: f.content }); })
      // No such file (or it is outside the confined tree, though an approval
      // never proposes that): treated as "does not exist yet", not a failure
      // to report — a create is a perfectly normal reason a read would 404.
      .catch(() => { if (live) setExisting({ path, content: null }); });
    return () => { live = false; };
  }, [projectRoot, path]);

  const proposedLines = proposed === '' ? [] : proposed.split('\n');
  const loading = existing === null || existing.path !== path;

  const rows = useMemo(
    () => (loading ? null : diffFiles(existing!.content, proposed)),
    [loading, existing, proposed]);

  const visibleRows = rows && !showAll ? rows.slice(0, 40) : rows;
  const truncated = rows !== null && rows.length > 40;

  return (
    <>
      <div className="approval-effect">
        Write <code>{path}</code>
        <span className="muted small">
          {' — '}
          {loading
            ? `${proposedLines.length} lines`
            : existing!.content === null
              ? `new file, ${proposedLines.length} lines`
              : `${proposedLines.length} lines`}
        </span>
      </div>
      {loading ? (
        <pre className="approval-args">
          {proposedLines.slice(0, 24).map((line, i) => (
            <div key={i}><span className="lineno">{i + 1}</span>{line || ' '}</div>
          ))}
        </pre>
      ) : (
        <div className="approval-diff">
          <DiffLines rows={visibleRows!} path={path} />
        </div>
      )}
      {truncated && (
        <button className="ghost" onClick={onShowAll}>
          {showAll ? 'show less' : `show all ${rows!.length} lines`}
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

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
  if (isBad(status)) return 'bad';
  return 'ok';
}

function isBad(status: string): boolean {
  return status === 'failed' || status === 'aborted';
}
