/**
 * Project picker. Choosing a project is a deliberate act with a visible
 * result — never a free-text path that silently disagrees with the file tree
 * beside it.
 */

import { useEffect, useState } from 'react';

import { api, type BrowseResponse } from '../api.ts';

export function ProjectPicker({
  initialPath, onPick, onClose,
}: {
  initialPath: string;
  onPick: (path: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  const go = (path: string): void => {
    api.browse(path)
      .then((r) => { setData(r); setManual(r.path); setError(null); })
      .catch((e: Error) => setError(e.message));
  };

  useEffect(() => { go(initialPath); }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Open a project folder</strong>
          <button onClick={onClose}>✕</button>
        </div>

        <p className="muted small">
          The agent can read and write anywhere inside the folder you choose,
          and nowhere outside it.
        </p>

        <div className="row">
          <input
            type="text"
            value={manual}
            spellCheck={false}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') go(manual); }}
          />
          <button onClick={() => go(manual)}>Go</button>
          <button onClick={() => go(data?.home ?? '~')}>Home</button>
        </div>

        {error && <div className="error small">{error}</div>}

        {data && (
          <>
            <div className="picker-current">
              <code>{data.path}</code>
              {data.isProject && <span className="tag ok">has agent history</span>}
            </div>

            <div className="picker-list">
              {data.parent && (
                <div className="tree-row" onClick={() => go(data.parent!)}>
                  📁 <span className="muted">.. (parent)</span>
                </div>
              )}
              {data.entries.length === 0 && (
                <div className="muted pad small">No subfolders here.</div>
              )}
              {data.entries.map((e) => (
                <div key={e.path} className="tree-row" onDoubleClick={() => go(e.path)}>
                  <span onClick={() => go(e.path)} style={{ flex: 1 }}>📁 {e.name}</span>
                  <button className="ghost" onClick={() => onPick(e.path)}>open</button>
                </div>
              ))}
            </div>

            <div className="modal-foot">
              <button className="primary" onClick={() => onPick(data.path)}>
                Open this folder
              </button>
              <button onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
