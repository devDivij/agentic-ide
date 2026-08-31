/**
 * Project tree, file viewer, and a small editor.
 *
 * Reading is the common case and stays one click away: files open highlighted
 * and read-only, and clicking lines yields a `@path:line` tag the composer
 * understands, which pins that exact code into the agent's context.
 *
 * Editing is deliberate — you press Edit. The agent writes most of the code
 * here, but "fix this one character yourself" should not require leaving the
 * window, and the alternative was alt-tabbing to another editor and then
 * wondering which copy of the file was newer.
 *
 * Breadcrumbs are anchored at the project root so "inside the project" is
 * visible at a glance, and browsing a subfolder offers "open as project"
 * explicitly — changing what the agent can write to is a deliberate act.
 */

import { useEffect, useRef, useState } from 'react';

import { api } from '../api.ts';
import { highlight, type Token } from '../highlight.ts';

interface Entry { name: string; directory: boolean }

export function Files({
  projectRoot, filesChangedAt, agentRunning, onPin, onOpenProject, onSaved,
}: {
  projectRoot: string;
  /**
   * Bumped by the event stream each time the agent writes a file. Without it
   * the tree showed whatever was on disk when you last navigated, so files
   * the agent had just created were simply invisible.
   */
  filesChangedAt: number;
  /** A task is running: anything you save may land in its review diff. */
  agentRunning: boolean;
  onPin: (ref: string) => void;
  onOpenProject: (absolutePath: string) => void;
  onSaved: (message: string) => void;
}): JSX.Element {
  const [dir, setDir] = useState('.');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [openFile, setOpenFile] = useState<{ path: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  /** Edit state. `buffer` is what you typed; `openFile.content` is the disk. */
  const [editing, setEditing] = useState(false);
  const [buffer, setBuffer] = useState('');
  const [saving, setSaving] = useState(false);
  /** Set when the file changed underneath an unsaved edit. */
  const [conflict, setConflict] = useState(false);
  /** Our own writes, so the tree refreshes without waiting for the agent. */
  const [savedAt, setSavedAt] = useState(0);

  const dirty = editing && openFile !== null && buffer !== openFile.content;

  // Reset the cursor whenever the project changes.
  useEffect(() => {
    setDir('.'); setOpenFile(null); setEditing(false); setConflict(false);
  }, [projectRoot]);

  useEffect(() => {
    if (!projectRoot) { setEntries([]); return; }
    api.listFiles(projectRoot, dir)
      .then((r) => { setEntries(r.entries); setError(null); })
      .catch((e: Error) => { setError(e.message); setEntries([]); });
  }, [projectRoot, dir, filesChangedAt, savedAt]);

  // The effect below is keyed on the change signal alone, so its closure is
  // stale by design. These are how it reads today's values instead.
  const dirtyRef = useRef(false);
  const fileRef = useRef(openFile);
  dirtyRef.current = dirty;
  fileRef.current = openFile;

  // Re-read the open file after a write, replacing only its text: `selected`
  // is separate state, so the reader's line selection survives. Deliberately
  // keyed on the change signal alone — including `openFile` here would make
  // this effect retrigger itself on every fetch.
  //
  // An unsaved edit is never overwritten. The agent writing the file you are
  // halfway through editing is exactly when losing your typing would hurt
  // most, so that case raises a conflict banner and leaves the buffer alone.
  useEffect(() => {
    if (!projectRoot || !openFile || filesChangedAt === 0) return;
    api.readFile(projectRoot, openFile.path)
      .then((fresh) => {
        const current = fileRef.current;
        if (current?.path !== fresh.path) return;    // you moved on; drop it
        if (dirtyRef.current) {
          if (fresh.content !== current.content) setConflict(true);
          return;
        }
        setOpenFile(fresh);
        setBuffer(fresh.content);
      })
      .catch(() => undefined);
  }, [filesChangedAt]);

  const open = (entry: Entry): void => {
    const next = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    if (entry.directory) { setDir(next); return; }
    if (dirty && !confirm('Discard unsaved changes to the open file?')) return;
    api.readFile(projectRoot, next)
      .then((f) => {
        setOpenFile(f);
        setBuffer(f.content);
        setSelected(new Set());
        setEditing(false);
        setConflict(false);
      })
      .catch((e: Error) => setError(e.message));
  };

  const save = (): void => {
    if (!openFile || saving) return;
    setSaving(true);
    api.writeFile(projectRoot, openFile.path, buffer)
      .then(() => {
        setOpenFile({ path: openFile.path, content: buffer });
        setConflict(false);
        setSavedAt(Date.now());
        onSaved(`Saved ${openFile.path}`);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const revert = (): void => {
    if (!openFile) return;
    api.readFile(projectRoot, openFile.path)
      .then((f) => { setOpenFile(f); setBuffer(f.content); setConflict(false); })
      .catch((e: Error) => setError(e.message));
  };

  const crumbs = dir === '.' ? [] : dir.split('/');
  const projectName = projectRoot.split('/').filter(Boolean).pop() ?? projectRoot;

  const toggleLine = (lineNo: number): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(lineNo)) next.delete(lineNo); else next.add(lineNo);
      return next;
    });
  };

  const pinSelection = (): void => {
    if (!openFile) return;
    if (selected.size === 0) { onPin(`@${openFile.path}`); return; }
    const sorted = [...selected].sort((a, b) => a - b);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    onPin(first === last ? `@${openFile.path}:${first}` : `@${openFile.path}:${first}-${last}`);
    setSelected(new Set());
  };

  if (!projectRoot) {
    return (
      <div className="files">
        <div className="empty pad">No project open. Choose a folder to begin.</div>
      </div>
    );
  }

  return (
    <div className="files">
      <div className="tree">
        <div className="crumbs">
          <span className="crumb root" onClick={() => setDir('.')} title={projectRoot}>
            {projectName}
          </span>
          {crumbs.map((c, i) => (
            <span key={i}>
              <span className="crumb-sep">/</span>
              <span className="crumb" onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}>
                {c}
              </span>
            </span>
          ))}
        </div>

        {dir !== '.' && (
          <div className="subproject-hint">
            <span className="muted small">Browsing a subfolder.</span>
            <button
              className="ghost"
              title="Make this folder the project the agent works in"
              onClick={() => onOpenProject(`${projectRoot}/${dir}`)}
            >
              open as project
            </button>
          </div>
        )}

        {error && <div className="error small pad">{error}</div>}

        <div className="tree-list">
          {dir !== '.' && (
            <div
              className="tree-row"
              onClick={() =>
                setDir(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '.')}
            >
              <span className="muted">📁 ..</span>
            </div>
          )}
          {entries.length === 0 && !error && (
            <div className="muted small pad">Empty folder.</div>
          )}
          {entries.map((e) => (
            <div
              key={e.name}
              className={`tree-row ${openFile?.path.endsWith(e.name) && !e.directory ? 'active' : ''}`}
              onClick={() => open(e)}
            >
              {e.directory ? '📁' : '📄'} {e.name}
            </div>
          ))}
        </div>
      </div>

      <div className="viewer">
        {openFile ? (
          <>
            <div className="viewer-head">
              <code title={openFile.path}>
                {openFile.path}{dirty && <span className="dirty-dot" title="Unsaved changes"> ●</span>}
              </code>
              <div className="row">
                {editing ? (
                  <>
                    <button
                      className="primary"
                      disabled={!dirty || saving}
                      onClick={save}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={() => {
                        if (dirty && !confirm('Discard unsaved changes?')) return;
                        setBuffer(openFile.content);
                        setEditing(false);
                        setConflict(false);
                      }}
                    >
                      Done
                    </button>
                  </>
                ) : (
                  <>
                    {selected.size > 0 && (
                      <span className="muted small">{selected.size} line(s) selected</span>
                    )}
                    <button onClick={pinSelection}>
                      {selected.size > 0 ? 'Reference selection' : 'Reference file'}
                    </button>
                    <button onClick={() => { setBuffer(openFile.content); setEditing(true); }}>
                      Edit
                    </button>
                  </>
                )}
              </div>
            </div>

            {editing && conflict && (
              <div className="warn-banner small">
                This file changed on disk while you were editing it. Saving
                overwrites those changes.
                <button className="ghost" onClick={revert}>reload from disk</button>
              </div>
            )}

            {editing && agentRunning && !conflict && (
              <div className="warn-banner small">
                A task is running. Anything you save now becomes part of that
                task's review diff, indistinguishable from the agent's own edits.
              </div>
            )}

            {editing
              ? (
                <Editor
                  path={openFile.path}
                  value={buffer}
                  onChange={setBuffer}
                  onSave={save}
                />
              ) : (
                <Reader
                  path={openFile.path}
                  content={openFile.content}
                  selected={selected}
                  onToggleLine={toggleLine}
                />
              )}
          </>
        ) : (
          <div className="empty pad">
            Select a file to read it. Click lines to point the agent at exact code.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Highlighted, line-numbered, and clickable — clicking is how you pin code. */
function Reader({
  path, content, selected, onToggleLine,
}: {
  path: string;
  content: string;
  selected: Set<number>;
  onToggleLine: (lineNo: number) => void;
}): JSX.Element {
  const lines = highlight(content, path);
  return (
    <pre className="code">
      {lines.map((tokens, i) => (
        <div
          key={i}
          className={`code-line ${selected.has(i + 1) ? 'sel' : ''}`}
          onClick={() => onToggleLine(i + 1)}
          title="Click to select; then Reference selection to point the agent here"
        >
          <span className="lineno">{i + 1}</span>
          <span className="linetext"><Painted tokens={tokens} /></span>
        </div>
      ))}
    </pre>
  );
}

/**
 * Tokens as elements, never as an HTML string.
 *
 * This is the reason the highlighter emits token objects: file contents come
 * off disk unexamined, React escapes them, and a file containing
 * `<img onerror=…>` renders as the text it is.
 */
function Painted({ tokens }: { tokens: Token[] }): JSX.Element {
  if (tokens.length === 0) return <>{' '}</>;
  return (
    <>
      {tokens.map((t, i) => (
        t.cls ? <span key={i} className={t.cls}>{t.text}</span> : <span key={i}>{t.text}</span>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/**
 * A textarea over a highlighted copy of the same text.
 *
 * The technique, and why it is this one: the textarea is the real editor —
 * it owns the caret, the selection, undo, IME, and the scrolling — and it is
 * painted with transparent text so what you actually see is the highlighted
 * `<pre>` behind it. The two layers agree because they are given identical
 * type metrics and padding in CSS (see `.editor-highlight` / `.editor-input`);
 * change one and you must change the other.
 *
 * The alternative — a contenteditable — means owning caret placement and undo
 * by hand, which is a much larger thing to get right than colour.
 */
function Editor({
  path, value, onChange, onSave,
}: {
  path: string;
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
}): JSX.Element {
  const input = useRef<HTMLTextAreaElement>(null);
  const painted = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);

  const lines = highlight(value, path);

  // The textarea scrolls; the layers behind it are dragged along. Doing it the
  // other way round (a container that scrolls everything) loses the browser's
  // own "keep the caret in view" behaviour, which is not worth reimplementing.
  const syncScroll = (): void => {
    const el = input.current;
    if (!el) return;
    if (painted.current) {
      painted.current.scrollTop = el.scrollTop;
      painted.current.scrollLeft = el.scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = el.scrollTop;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSave();
      return;
    }
    // Tab indents instead of leaving the field. An editor that cannot type a
    // tab is not an editor, and losing focus mid-line is worse than the
    // accessibility cost here — Escape still gets you out.
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: start, selectionEnd: end } = el;
      const next = `${value.slice(0, start)}  ${value.slice(end)}`;
      onChange(next);
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 2; });
    }
    if (e.key === 'Escape') e.currentTarget.blur();
  };

  return (
    <div className="editor">
      <div className="editor-gutter" ref={gutter} aria-hidden="true">
        {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      <div className="editor-body">
        <pre className="editor-highlight" ref={painted} aria-hidden="true">
          {lines.map((tokens, i) => (
            <div key={i} className="editor-row"><Painted tokens={tokens} /></div>
          ))}
        </pre>
        <textarea
          className="editor-input"
          ref={input}
          value={value}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          wrap="off"
          aria-label={`Editing ${path}`}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}
