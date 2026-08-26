/**
 * Project tree and file viewer. Read-only by design: the agent writes the
 * code; the human reads, reviews and points. Clicking lines yields a
 * `@path:line` tag the composer understands, which pins that exact code into
 * the agent's context.
 *
 * Breadcrumbs are anchored at the project root so "inside the project" is
 * visible at a glance, and browsing a subfolder offers "open as project"
 * explicitly — changing what the agent can write to is a deliberate act.
 */

import { useEffect, useState } from 'react';

import { api } from '../api.ts';

interface Entry { name: string; directory: boolean }

export function Files({
  projectRoot, onPin, onOpenProject,
}: {
  projectRoot: string;
  onPin: (ref: string) => void;
  onOpenProject: (absolutePath: string) => void;
}): JSX.Element {
  const [dir, setDir] = useState('.');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [openFile, setOpenFile] = useState<{ path: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Reset the cursor whenever the project changes.
  useEffect(() => { setDir('.'); setOpenFile(null); }, [projectRoot]);

  useEffect(() => {
    if (!projectRoot) { setEntries([]); return; }
    api.listFiles(projectRoot, dir)
      .then((r) => { setEntries(r.entries); setError(null); })
      .catch((e: Error) => { setError(e.message); setEntries([]); });
  }, [projectRoot, dir]);

  const open = (entry: Entry): void => {
    const next = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    if (entry.directory) { setDir(next); return; }
    api.readFile(projectRoot, next)
      .then((f) => { setOpenFile(f); setSelected(new Set()); })
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
              <code title={openFile.path}>{openFile.path}</code>
              <div className="row">
                {selected.size > 0 && (
                  <span className="muted small">{selected.size} line(s) selected</span>
                )}
                <button onClick={pinSelection}>
                  {selected.size > 0 ? 'Reference selection' : 'Reference file'}
                </button>
              </div>
            </div>
            <pre className="code">
              {openFile.content.split('\n').map((line, i) => (
                <div
                  key={i}
                  className={`code-line ${selected.has(i + 1) ? 'sel' : ''}`}
                  onClick={() => toggleLine(i + 1)}
                  title="Click to select; then Reference selection to point the agent here"
                >
                  <span className="lineno">{i + 1}</span>
                  <span className="linetext">{line || ' '}</span>
                </div>
              ))}
            </pre>
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
