/**
 * Project tree, file viewer, and a small editor — this project's own
 * in-browser IDE surface.
 *
 * Reading is the common case and stays one click away: files open highlighted
 * and read-only, and clicking lines yields a pin (see ../pins.ts) the
 * composer understands, pinning that exact code into the agent's context.
 *
 * Editing is deliberate — you press Edit. The agent writes most of the code
 * here, but "fix this one character yourself" should not require leaving the
 * window, and the alternative was alt-tabbing to another editor and then
 * wondering which copy of the file was newer.
 *
 * More than one file can be open at once (`tabs`, below). Only the ACTIVE
 * tab is kept live-synced against the agent's writes — the same effect the
 * single-file version had. A background tab is re-checked against disk only
 * when you switch back to it, which is also what makes switching away from a
 * dirty tab safe: nothing is discarded, it just goes quiet until you return.
 *
 * Breadcrumbs are anchored at the project root so "inside the project" is
 * visible at a glance, and browsing a subfolder offers "open as project"
 * explicitly — changing what the agent can write to is a deliberate act.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { api, type SearchResult } from '../api.ts';
import { highlight, type Token } from '../highlight.ts';
import type { PinRef } from '../pins.ts';

interface Entry { name: string; directory: boolean }

/** One open file. `content` is the last known disk state, `buffer` is what
 * you've typed — equal unless `editing` and you've changed something. */
interface Tab {
  path: string;
  content: string;
  buffer: string;
  editing: boolean;
  /** Disk changed under an unsaved edit; `revert()` is the way out. */
  conflict: boolean;
}

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
  /** A task is running: anything you save may land in its diff. */
  agentRunning: boolean;
  onPin: (pin: PinRef) => void;
  onOpenProject: (absolutePath: string) => void;
  onSaved: (message: string) => void;
}): JSX.Element {
  const [dir, setDir] = useState('.');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /** Set by a search-result click; the reader scrolls to it once. */
  const [scrollToLine, setScrollToLine] = useState<number | null>(null);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const active = tabs.find((t) => t.path === activePath) ?? null;
  const dirty = active !== null && active.buffer !== active.content;

  const [saving, setSaving] = useState(false);
  /** Our own writes, so the tree refreshes without waiting for the agent. */
  const [savedAt, setSavedAt] = useState(0);

  /** New file / new folder, typed inline at the top of the current folder. */
  const [creating, setCreating] = useState<'file' | 'folder' | null>(null);
  const [newName, setNewName] = useState('');
  /** Renaming an existing entry, in place. Holds the entry's CURRENT name. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const [searching, setSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);

  // Reset the cursor whenever the project changes.
  useEffect(() => {
    setDir('.'); setTabs([]); setActivePath(null);
    setSearching(false); setSearchResults([]); setSearchQuery('');
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
  const activeRef = useRef(active);
  dirtyRef.current = dirty;
  activeRef.current = active;

  // Re-read the ACTIVE file after a write, replacing only its text: a
  // background tab is never touched here (see `openPath`) -- syncing every
  // open tab on every agent write would mean one fetch per tab per write,
  // for tabs nobody is looking at.
  //
  // An unsaved edit is never overwritten. The agent writing the file you are
  // halfway through editing is exactly when losing your typing would hurt
  // most, so that case raises a conflict banner and leaves the buffer alone.
  useEffect(() => {
    if (!projectRoot || !active || filesChangedAt === 0) return;
    api.readFile(projectRoot, active.path)
      .then((fresh) => {
        const current = activeRef.current;
        if (!current || current.path !== fresh.path) return;    // you moved on; drop it
        if (dirtyRef.current) {
          if (fresh.content !== current.content) updateTab(fresh.path, { conflict: true });
          return;
        }
        updateTab(fresh.path, { content: fresh.content, buffer: fresh.content, conflict: false });
      })
      .catch(() => undefined);
  }, [filesChangedAt]);

  const updateTab = (path: string, patch: Partial<Tab>): void => {
    setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, ...patch } : t)));
  };

  /**
   * Bring a file to the foreground, opening a new tab if needed, and
   * optionally scroll to one line (a search result).
   *
   * Never discards anything -- unlike the single-file version, switching to
   * another file no longer needs to ask "discard unsaved changes?" first,
   * because nothing is being replaced: a dirty tab just goes to the
   * background with its buffer exactly as you left it.
   */
  const openPath = (path: string, line?: number): void => {
    setSelected(line !== undefined ? new Set([line]) : new Set());
    setScrollToLine(line ?? null);

    const existing = tabs.find((t) => t.path === path);
    setActivePath(path);
    if (existing) {
      if (existing.buffer === existing.content) {
        // Clean: cheap to just refresh from disk on arrival.
        api.readFile(projectRoot, path)
          .then((f) => updateTab(path, { content: f.content, buffer: f.content, conflict: false }))
          .catch(() => undefined);
      } else {
        // Dirty: never touch the buffer, but do flag a conflict if disk moved.
        api.readFile(projectRoot, path)
          .then((f) => { if (f.content !== existing.content) updateTab(path, { content: f.content, conflict: true }); })
          .catch(() => undefined);
      }
      return;
    }
    api.readFile(projectRoot, path)
      .then((f) => {
        setTabs((ts) => [...ts, {
          path, content: f.content, buffer: f.content, editing: false, conflict: false,
        }]);
      })
      .catch((e: Error) => { setError(e.message); setActivePath((p) => (p === path ? null : p)); });
  };

  const open = (entry: Entry): void => {
    const next = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    if (entry.directory) { setDir(next); return; }
    openPath(next);
  };

  const closeTab = (path: string, e?: React.MouseEvent): void => {
    e?.stopPropagation();
    const t = tabs.find((x) => x.path === path);
    if (t && t.buffer !== t.content && !confirm(`Discard unsaved changes to ${path}?`)) return;
    const next = tabs.filter((x) => x.path !== path);
    setTabs(next);
    if (activePath === path) setActivePath(next.length > 0 ? next[next.length - 1]!.path : null);
  };

  const save = (): void => {
    if (!active || saving) return;
    const { path, buffer } = active;
    setSaving(true);
    api.writeFile(projectRoot, path, buffer)
      .then(() => {
        updateTab(path, { content: buffer, conflict: false });
        setSavedAt(Date.now());
        onSaved(`Saved ${path}`);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const revert = (): void => {
    if (!active) return;
    const path = active.path;
    api.readFile(projectRoot, path)
      .then((f) => updateTab(path, { content: f.content, buffer: f.content, conflict: false }))
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
    if (!active) return;
    if (selected.size === 0) { onPin({ path: active.path }); return; }
    const sorted = [...selected].sort((a, b) => a - b);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    onPin({ path: active.path, startLine: first, endLine: last });
    setSelected(new Set());
  };

  // -- tree management: create, rename, delete -------------------------------

  const startCreate = (kind: 'file' | 'folder'): void => {
    setRenaming(null); setCreating(kind); setNewName('');
  };

  const submitCreate = (): void => {
    const name = newName.trim();
    if (!name || !creating) { setCreating(null); return; }
    const path = dir === '.' ? name : `${dir}/${name}`;
    const kind = creating;
    api.createEntry(projectRoot, path, kind === 'folder')
      .then(() => {
        setCreating(null); setNewName(''); setSavedAt(Date.now());
        if (kind === 'file') openPath(path);
      })
      .catch((e: Error) => setError(e.message));
  };

  const startRename = (entry: Entry): void => {
    setCreating(null); setRenaming(entry.name); setRenameValue(entry.name);
  };

  /** A rename of a folder moves everything under it -- remap any open tab
   * whose path was inside the renamed folder, not just an exact match. */
  const remapPath = (oldPath: string, newPath: string) => (path: string): string =>
    path === oldPath ? newPath
      : path.startsWith(`${oldPath}/`) ? newPath + path.slice(oldPath.length)
      : path;

  const submitRename = (entry: Entry): void => {
    const name = renameValue.trim();
    setRenaming(null);
    if (!name || name === entry.name) return;
    const oldPath = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    const newPath = dir === '.' ? name : `${dir}/${name}`;
    api.renameEntry(projectRoot, oldPath, newPath)
      .then(() => {
        const remap = remapPath(oldPath, newPath);
        setSavedAt(Date.now());
        setTabs((ts) => ts.map((t) => ({ ...t, path: remap(t.path) })));
        setActivePath((p) => (p ? remap(p) : p));
      })
      .catch((e: Error) => setError(e.message));
  };

  const doDelete = (entry: Entry): void => {
    const path = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    const warning = entry.directory
      ? `Delete "${entry.name}" and everything in it? This cannot be undone.`
      : `Delete "${entry.name}"? This cannot be undone.`;
    if (!confirm(warning)) return;
    api.deleteEntry(projectRoot, path)
      .then(() => {
        setSavedAt(Date.now());
        const gone = (p: string): boolean => p === path || p.startsWith(`${path}/`);
        const next = tabs.filter((t) => !gone(t.path));
        setTabs(next);
        if (activePath && gone(activePath)) {
          setActivePath(next.length > 0 ? next[next.length - 1]!.path : null);
        }
      })
      .catch((e: Error) => setError(e.message));
  };

  // -- project-wide search ----------------------------------------------------

  const runSearch = (): void => {
    const q = searchQuery.trim();
    if (!q) { setSearchResults([]); return; }
    setSearchBusy(true);
    api.search(projectRoot, q)
      .then((r) => setSearchResults(r.results))
      .catch((e: Error) => setError(e.message))
      .finally(() => setSearchBusy(false));
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

        <div className="tree-toolbar">
          <button className="ghost small" title="New file" onClick={() => startCreate('file')}>+ file</button>
          <button className="ghost small" title="New folder" onClick={() => startCreate('folder')}>+ folder</button>
          <button
            className={`ghost small ${searching ? 'active' : ''}`}
            title="Search this project"
            onClick={() => setSearching((v) => !v)}
          >
            search
          </button>
        </div>

        {searching && (
          <div className="search-panel">
            <input
              type="text"
              autoFocus
              placeholder="Search in project…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runSearch();
                if (e.key === 'Escape') setSearching(false);
              }}
            />
            {searchBusy && <div className="muted small pad">Searching…</div>}
            {!searchBusy && searchQuery.trim() && searchResults.length === 0 && (
              <div className="muted small pad">No matches.</div>
            )}
            <div className="search-results">
              {searchResults.map((r, i) => (
                <div
                  key={`${r.path}:${r.line}:${i}`}
                  className="search-result"
                  onClick={() => { openPath(r.path, r.line); }}
                >
                  <code>{r.path}:{r.line}</code>
                  <div className="search-result-text">{r.text}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {!searching && dir !== '.' && (
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

        {!searching && (
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
            {creating && (
              <div className="tree-row creating">
                <span>{creating === 'folder' ? '📁' : '📄'}</span>
                <input
                  type="text"
                  autoFocus
                  value={newName}
                  placeholder={creating === 'folder' ? 'folder name' : 'file name'}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitCreate();
                    if (e.key === 'Escape') setCreating(null);
                  }}
                  onBlur={submitCreate}
                />
              </div>
            )}
            {entries.length === 0 && !error && !creating && (
              <div className="muted small pad">Empty folder.</div>
            )}
            {entries.map((e) => {
              const path = dir === '.' ? e.name : `${dir}/${e.name}`;
              if (renaming === e.name) {
                return (
                  <div key={e.name} className="tree-row renaming">
                    <span>{e.directory ? '📁' : '📄'}</span>
                    <input
                      type="text"
                      autoFocus
                      value={renameValue}
                      onChange={(ev) => setRenameValue(ev.target.value)}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter') submitRename(e);
                        if (ev.key === 'Escape') setRenaming(null);
                      }}
                      onBlur={() => submitRename(e)}
                    />
                  </div>
                );
              }
              return (
                <div
                  key={e.name}
                  className={`tree-row ${activePath === path && !e.directory ? 'active' : ''}`}
                  onClick={() => open(e)}
                >
                  <span className="tree-row-label">{e.directory ? '📁' : '📄'} {e.name}</span>
                  <span className="tree-row-actions">
                    <button
                      className="row-action"
                      title="Rename"
                      onClick={(ev) => { ev.stopPropagation(); startRename(e); }}
                    >
                      ✎
                    </button>
                    <button
                      className="row-action"
                      title="Delete"
                      onClick={(ev) => { ev.stopPropagation(); doDelete(e); }}
                    >
                      🗑
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="viewer">
        {tabs.length > 0 && (
          <div className="tabs">
            {tabs.map((t) => (
              <div
                key={t.path}
                className={`tab ${t.path === activePath ? 'active' : ''}`}
                title={t.path}
                onClick={() => openPath(t.path)}
              >
                <span className="tab-label">{t.path.split('/').pop()}</span>
                {t.buffer !== t.content && <span className="dirty-dot"> ●</span>}
                <button className="tab-close" title="Close tab" onClick={(e) => closeTab(t.path, e)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {active ? (
          <>
            <div className="viewer-head">
              <code title={active.path}>
                {active.path}{dirty && <span className="dirty-dot" title="Unsaved changes"> ●</span>}
              </code>
              <div className="row">
                {active.editing ? (
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
                        updateTab(active.path, { buffer: active.content, editing: false, conflict: false });
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
                    <button onClick={() => updateTab(active.path, { editing: true })}>
                      Edit
                    </button>
                  </>
                )}
              </div>
            </div>

            {active.editing && active.conflict && (
              <div className="warn-banner small">
                This file changed on disk while you were editing it. Saving
                overwrites those changes.
                <button className="ghost" onClick={revert}>reload from disk</button>
              </div>
            )}

            {active.editing && agentRunning && !active.conflict && (
              <div className="warn-banner small">
                A task is running. Anything you save now becomes part of that
                task's diff, indistinguishable from the agent's own edits.
              </div>
            )}

            {active.editing
              ? (
                // Keyed on path: without it, switching between two files both
                // open for editing would reuse this instance, leaking one
                // file's find-bar state (query, scroll position) onto another.
                <Editor
                  key={active.path}
                  path={active.path}
                  value={active.buffer}
                  onChange={(v) => updateTab(active.path, { buffer: v })}
                  onSave={save}
                />
              ) : (
                <Reader
                  key={active.path}
                  path={active.path}
                  content={active.content}
                  selected={selected}
                  onToggleLine={toggleLine}
                  scrollToLine={scrollToLine}
                />
              )}
          </>
        ) : (
          <div className="empty pad">
            {tabs.length > 0
              ? 'Select a tab above.'
              : 'Select a file to read it. Click lines to point the agent at exact code.'}
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
  path, content, selected, onToggleLine, scrollToLine,
}: {
  path: string;
  content: string;
  selected: Set<number>;
  onToggleLine: (lineNo: number) => void;
  /** A search-result jump target: scrolled into view once, then left alone. */
  scrollToLine: number | null;
}): JSX.Element {
  const lines = highlight(content, path);
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (scrollToLine === null) return;
    lineRefs.current.get(scrollToLine)?.scrollIntoView({ block: 'center' });
  }, [scrollToLine, path]);

  return (
    <pre className="code">
      {lines.map((tokens, i) => (
        <div
          key={i}
          ref={(el) => {
            if (el) lineRefs.current.set(i + 1, el); else lineRefs.current.delete(i + 1);
          }}
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
 *
 * Ctrl/Cmd+F opens an in-file find bar. Native browser find cannot reach a
 * textarea's value at all, so this is the one place in the app it has to be
 * reimplemented rather than left to the browser — the read-only Reader above
 * is real DOM text and the browser's own Ctrl+F already searches it fine.
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
  const gutterLines = useRef<Map<number, HTMLDivElement>>(new Map());
  const findInput = useRef<HTMLInputElement>(null);

  const lines = highlight(value, path);
  const rawLines = useMemo(() => value.split('\n'), [value]);

  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  const matches = useMemo(() => {
    if (!query) return [] as number[];
    const q = query.toLowerCase();
    const out: number[] = [];
    rawLines.forEach((l, i) => { if (l.toLowerCase().includes(q)) out.push(i); });
    return out;
  }, [rawLines, query]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const current = matches.length > 0
    ? matches[((index % matches.length) + matches.length) % matches.length]!
    : null;

  const syncScroll = (): void => {
    const el = input.current;
    if (!el) return;
    if (painted.current) {
      painted.current.scrollTop = el.scrollTop;
      painted.current.scrollLeft = el.scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = el.scrollTop;
  };

  // Jump the textarea to whichever line is current, then drag the painted
  // layers along the same way an ordinary scroll would.
  useEffect(() => {
    if (current === null) return;
    const line = gutterLines.current.get(current);
    const el = input.current;
    if (!line || !el) return;
    el.scrollTop = line.offsetTop - el.clientHeight / 2;
    syncScroll();
  }, [current]);

  const openFind = (): void => {
    setFindOpen(true);
    requestAnimationFrame(() => { findInput.current?.focus(); findInput.current?.select(); });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'f' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); openFind(); return; }
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
      {findOpen && (
        <div className="find-bar">
          <input
            ref={findInput}
            type="text"
            autoFocus
            placeholder="Find in file…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setIndex((i) => i + (e.shiftKey ? -1 : 1));
              if (e.key === 'Escape') { e.preventDefault(); setFindOpen(false); input.current?.focus(); }
            }}
          />
          <span className="muted small">
            {matches.length > 0
              ? `${((index % matches.length) + matches.length) % matches.length + 1}/${matches.length}`
              : '0/0'}
          </span>
          <button className="ghost small" disabled={matches.length === 0} onClick={() => setIndex((i) => i - 1)}>▲</button>
          <button className="ghost small" disabled={matches.length === 0} onClick={() => setIndex((i) => i + 1)}>▼</button>
          <button
            className="ghost small"
            title="Close (Esc)"
            onClick={() => { setFindOpen(false); input.current?.focus(); }}
          >
            ✕
          </button>
        </div>
      )}
      <div className="editor-gutter" ref={gutter} aria-hidden="true">
        {lines.map((_, i) => (
          <div
            key={i}
            ref={(el) => { if (el) gutterLines.current.set(i, el); else gutterLines.current.delete(i); }}
          >
            {i + 1}
          </div>
        ))}
      </div>
      <div className="editor-body">
        <pre className="editor-highlight" ref={painted} aria-hidden="true">
          {lines.map((tokens, i) => (
            <div
              key={i}
              className={`editor-row ${current === i ? 'find-current' : matchSet.has(i) ? 'find-hit' : ''}`}
            >
              <Painted tokens={tokens} />
            </div>
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
