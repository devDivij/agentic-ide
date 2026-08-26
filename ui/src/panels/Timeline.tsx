/**
 * The pieces the chat timeline is built from.
 *
 * Chat.tsx decides what goes in what order; everything here just renders one
 * entry. The guiding rule after watching a real run go wrong: never show a
 * state without its reason. A ✕ with no explanation is worse than no ✕.
 */

import { useEffect, useReducer, useState } from 'react';

import type {
  ApprovalRequest, AsideBubble, FailureInfo, StepWire, TaskEndPayload, TraceNode,
} from '../types.ts';
import {
  activityFeed, currentActivity, failuresByStep, shortModel, stepDurations, taskEndOf,
} from '../activity.ts';

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
  onApprove: (eventId: number, approved: boolean) => void;
  onReview: () => void;
  onResume: (taskId: string) => void;
  onRetry: (prompt: string) => void;
  onAsk: (prompt: string) => void;
  onExplain: (taskId: string) => void;
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
  task, approvals, actions, explaining,
}: {
  task: ChatTask;
  approvals: ApprovalRequest[];
  actions: TaskActions;
  explaining: boolean;
}): JSX.Element {
  const running = task.live && task.status === 'running';
  useTick(running);

  const failures = failuresByStep(task.nodes);
  const durations = stepDurations(task.nodes);
  const end = taskEndOf(task.nodes);
  const elapsed = running ? Date.now() - task.createdAt : task.elapsedMs;

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
              />
            ))}
          </div>
        ) : (
          <div className="muted small">
            {running ? 'Working out a plan…' : 'No plan was produced.'}
          </div>
        )}

        {running && <ActivityStrip nodes={task.nodes} />}

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
        <Approval key={a.eventId} request={a} onDecide={(ok) => actions.onApprove(a.eventId, ok)} />
      ))}
    </>
  );
}

function Step({
  step, durationMs, failure,
}: {
  step: StepWire; durationMs: number | undefined; failure: FailureInfo | undefined;
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
function ActivityStrip({ nodes }: { nodes: TraceNode[] }): JSX.Element {
  const now = currentActivity(nodes);
  const feed = activityFeed(nodes);

  return (
    <div className="activity">
      {now && (
        <div className="activity-now">
          <span className="spinner" />
          <b>{now.phase}</b>
          <span className="muted">{now.detail}</span>
          <span className="activity-elapsed">
            {Math.max(0, Math.round((Date.now() - now.since) / 1000))}s
          </span>
        </div>
      )}
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
 */
export function Approval({
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
