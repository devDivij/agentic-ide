/**
 * Human-in-the-loop diff review: accept or reject hunk by hunk, with
 * accept-all / reject-all as shortcuts rather than the only options.
 *
 * Edits to existing test files are called out separately: accuracy is
 * measured by tests passing, so an agent that rewrites a failing test has
 * defeated the measurement rather than done the work.
 */

import { useEffect, useState } from 'react';

import type { DiffHunk, ReviewBundle } from '../types.ts';
import { api } from '../api.ts';

export function Review({
  projectRoot, taskId, onApplied,
}: {
  projectRoot: string;
  taskId: string | null;
  onApplied: (message: string) => void;
}): JSX.Element {
  const [bundle, setBundle] = useState<ReviewBundle | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!projectRoot || !taskId) { setBundle(null); return; }
    api.review(projectRoot, taskId)
      .then((b) => {
        setBundle(b);
        // Default to accepting everything: approval is the common case, and
        // starting from nothing selected makes the safe path the tedious one.
        setAccepted(new Set(b.hunks.map((h) => h.id)));
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [projectRoot, taskId]);

  const toggle = (id: string): void => {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const apply = async (): Promise<void> => {
    if (!taskId) return;
    setBusy(true);
    try {
      const result = await api.applyReview(projectRoot, taskId, [...accepted]);
      onApplied(
        `Applied ${result.applied} hunk(s)` +
        (result.rejected > 0 ? `, rejected ${result.rejected}` : '') +
        (result.files.length ? ` — ${result.files.join(', ')}` : ''));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!taskId) return <Empty>Run a task to review its changes here.</Empty>;
  if (error) return <div className="panel error">{error}</div>;
  if (!bundle) return <Empty>Loading the diff…</Empty>;
  if (bundle.hunks.length === 0) {
    // Distinguish "the agent decided nothing needed changing" from "the review
    // screen is broken" — they look identical otherwise, and one of them is
    // a legitimate outcome.
    return (
      <Empty>
        <div>
          <p>This task changed no files, so there is nothing to review.</p>
          <p className="muted small">
            That usually means the agent judged the requested change to be already
            present. If you expected an edit, say more specifically what should
            differ and pin the file with an <code>@path</code> tag.
          </p>
        </div>
      </Empty>
    );
  }

  const testHunks = bundle.hunks.filter((h) => h.touchesTests).length;

  return (
    <div className="panel review">
      <div className="review-bar">
        <span><b>{accepted.size}</b> of {bundle.hunks.length} hunks accepted</span>
        <button onClick={() => setAccepted(new Set(bundle.hunks.map((h) => h.id)))}>
          Accept all
        </button>
        <button onClick={() => setAccepted(new Set())}>Reject all</button>
        <button className="primary" disabled={busy} onClick={() => void apply()}>
          {busy ? 'Applying…' : 'Apply to working tree'}
        </button>
      </div>

      {testHunks > 0 && (
        <div className="warn-banner">
          {testHunks} hunk(s) modify existing test files. A green suite the agent
          rewrote is not evidence — read these before accepting.
        </div>
      )}

      {bundle.hunks.map((hunk) => (
        <HunkView
          key={hunk.id}
          hunk={hunk}
          accepted={accepted.has(hunk.id)}
          onToggle={() => toggle(hunk.id)}
        />
      ))}
    </div>
  );
}

function HunkView({
  hunk, accepted, onToggle,
}: {
  hunk: DiffHunk; accepted: boolean; onToggle: () => void;
}): JSX.Element {
  return (
    <div className={`hunk ${accepted ? '' : 'rejected'}`}>
      <div className="hunk-head" onClick={onToggle}>
        <input type="checkbox" checked={accepted} readOnly />
        <code>{hunk.file}</code>
        {hunk.touchesTests && <span className="tag warn">test file</span>}
        {hunk.stepId && (
          <span className="tag" title="Plan step that produced this">{hunk.stepId}</span>
        )}
        {!accepted && <span className="tag">rejected</span>}
      </div>
      <pre className="diff">
        {hunk.patch.split('\n').map((line, i) => (
          <div key={i} className={diffLineClass(line)}>{line || ' '}</div>
        ))}
      </pre>
    </div>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return 'dl-meta';
  if (line.startsWith('+')) return 'dl-add';
  if (line.startsWith('-')) return 'dl-del';
  return 'dl-ctx';
}

function Empty({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="panel empty">{children}</div>;
}
