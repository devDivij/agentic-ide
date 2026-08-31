/**
 * Rendering a `DiffRow[]` (see `ui/src/diff.ts`) as the code-host style block:
 * two line-number gutters, the +/- marker in its own column, syntax colour,
 * and the changed part of an edited line picked out inside the row.
 *
 * Shared between the Review tab (diffing two checkpoints after the fact) and
 * the approval prompt (diffing a proposed write against disk before it
 * happens) — the same two texts deserve to look like the same diff regardless
 * of which moment produced them.
 */

import type { DiffRow } from '../diff.ts';
import { paintRow } from '../diff.ts';
import type { Token } from '../highlight.ts';

export function DiffLines({ rows, path }: { rows: DiffRow[]; path: string }): JSX.Element {
  return (
    <div className="diff">
      {rows.map((row, i) => <Row key={i} row={row} path={path} />)}
    </div>
  );
}

/**
 * One line: two line-number gutters, the marker, and the code.
 *
 * The numbers are plain text in fixed-width gutters with `user-select: none`
 * in CSS, so copying a block of the diff yields the code and not a column of
 * numbers glued to the front of every line.
 */
function Row({ row, path }: { row: DiffRow; path: string }): JSX.Element {
  if (row.kind === 'meta') {
    return (
      <div className="dl dl-meta">
        <span className="dl-no" />
        <span className="dl-no" />
        <span className="dl-mark" />
        <span className="dl-text">{row.text}</span>
      </div>
    );
  }

  const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ';
  const tokens = paintRow(row, path, row.kind === 'add' ? 'word-add' : 'word-del');

  return (
    <div className={`dl dl-${row.kind}`}>
      <span className="dl-no">{row.oldNo ?? ''}</span>
      <span className="dl-no">{row.newNo ?? ''}</span>
      <span className="dl-mark">{marker}</span>
      <span className="dl-text"><Painted tokens={tokens} /></span>
    </div>
  );
}

/** Tokens as elements. Never an HTML string — this is model output. */
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
