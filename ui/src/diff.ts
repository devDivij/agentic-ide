/**
 * Turning a unified diff hunk into the rows a review screen renders.
 *
 * The server already splits a task's changes into hunks (see
 * `server/agentzero/web/review.py`); this is the other half — what a hunk looks
 * like once a person has to read it. Three things a raw `+`/`-` dump does
 * not give you, and that reading a diff actually depends on:
 *
 *   1. **Line numbers on both sides.** "It broke at line 240" is unanswerable
 *      from a patch body; the `@@ -a,b +c,d @@` header holds the answer and
 *      nothing was decoding it.
 *   2. **The marker out of the text.** `+  const x = 1` is not a line of
 *      code, and feeding it to a syntax highlighter tokenises the `+` as an
 *      operator. The marker belongs in the gutter; `text` here is the line.
 *   3. **What changed *within* a line.** A one-character edit and a rewritten
 *      line look identical when both are a red row above a green one.
 *
 * Pure string logic, no DOM: `server/test/agent.test.ts` imports it directly.
 */

import { highlight, type Token } from './highlight.ts';

export type RowKind = 'meta' | 'add' | 'del' | 'ctx';

/** A half-open `[start, end)` character range within a row's `text`. */
export type Range = [number, number];

export interface DiffRow {
  kind: RowKind;
  /** 1-based line number on the pre-change side; null for additions. */
  oldNo: number | null;
  /** 1-based line number on the post-change side; null for deletions. */
  newNo: number | null;
  /** The line itself, with the leading diff marker removed. */
  text: string;
  /**
   * Where this line differs from the line it replaced (or was replaced by).
   * Empty when there is no counterpart, or when the two lines are too
   * dissimilar for a within-line comparison to mean anything.
   */
  changed: Range[];
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// ---------------------------------------------------------------------------
// Diffing two whole files (before a write ever happens)
// ---------------------------------------------------------------------------

/**
 * A line-level diff between two full texts.
 *
 * This exists for the approval prompt: `write_file` proposes a complete
 * replacement file *before* anything lands on disk, so there is no git
 * checkpoint pair to ask the server for a hunk from (that machinery, in
 * `server/agentzero/web/review.py`, only exists after the fact). The comparison has
 * to happen here, client-side, against whatever is on disk right now.
 *
 * `oldText === null` means the file does not exist yet — a create, not an
 * edit — and every line is shown as added with no diffing to do.
 */
export function diffFiles(oldText: string | null, newText: string): DiffRow[] {
  const newLines = newText === '' ? [] : newText.split('\n');

  if (oldText === null) {
    return newLines.map((text, i) =>
      ({ kind: 'add' as const, oldNo: null, newNo: i + 1, text, changed: [] }));
  }

  const oldLines = oldText === '' ? [] : oldText.split('\n');

  if (oldLines.length + newLines.length > MAX_DIFF_LINES) {
    // Too large to run an edit-distance search over in a browser tab without
    // the risk of hanging it — shown as one full replacement instead, which
    // is still true, just not correlated line-for-line. The word-level
    // matcher below still finds nothing to pair here, which is correct: nothing
    // has been shown to correspond.
    return markWordChanges([
      ...oldLines.map((text, i) =>
        ({ kind: 'del' as const, oldNo: i + 1, newNo: null, text, changed: [] })),
      ...newLines.map((text, i) =>
        ({ kind: 'add' as const, oldNo: null, newNo: i + 1, text, changed: [] })),
    ]);
  }

  const rows: DiffRow[] = myersDiff(oldLines, newLines).map((op) => {
    if (op.type === 'eq') {
      return { kind: 'ctx' as const, oldNo: op.oldIndex! + 1, newNo: op.newIndex! + 1,
                text: oldLines[op.oldIndex!]!, changed: [] };
    }
    if (op.type === 'del') {
      return { kind: 'del' as const, oldNo: op.oldIndex! + 1, newNo: null,
                text: oldLines[op.oldIndex!]!, changed: [] };
    }
    return { kind: 'add' as const, oldNo: null, newNo: op.newIndex! + 1,
              text: newLines[op.newIndex!]!, changed: [] };
  });
  return markWordChanges(rows);
}

/**
 * Combined line count beyond which `diffFiles` stops trying to correlate the
 * two sides and falls back to "everything old removed, everything new added".
 *
 * Myers' algorithm is O(N·D) in both time and the trace memory it keeps for
 * backtracking, where D is the number of differing lines — cheap for a
 * typical edit (D is small) but unbounded for two files with almost nothing
 * in common. The cap bounds the worst case rather than the common one.
 */
const MAX_DIFF_LINES = 1200;

interface EditOp { type: 'eq' | 'del' | 'add'; oldIndex?: number; newIndex?: number }

/**
 * Myers' O(N·D) shortest-edit-script algorithm, restricted to line arrays.
 *
 * Standard two-phase shape: `trace` walks forward recording, for each edit
 * distance `d`, the furthest-reaching path on every diagonal `k`; the second
 * pass walks that trace backward to recover which lines were kept, added, or
 * removed. Written for clarity over the classic references, not for the
 * linear-space refinement — `MAX_DIFF_LINES` is the guard against its
 * quadratic-ish worst case, not an attempt to avoid it structurally.
 */
function myersDiff(a: string[], b: string[]): EditOp[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];

  const offset = max;
  const v: number[] = new Array(2 * max + 1).fill(0);
  const trace: number[][] = [];

  outer:
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  const ops: EditOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const row = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && row[offset + k - 1]! < row[offset + k + 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = row[offset + prevK]!;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ type: 'eq', oldIndex: x - 1, newIndex: y - 1 });
      x--; y--;
    }
    if (d > 0) {
      if (down) { ops.push({ type: 'add', newIndex: y - 1 }); y--; }
      else { ops.push({ type: 'del', oldIndex: x - 1 }); x--; }
    }
  }
  return ops.reverse();
}

/**
 * Parse one hunk body into rows.
 *
 * Tolerant in the same way the server's parser is: an unexpected line becomes
 * a `meta` row rather than throwing, because one odd line must not be able to
 * make a whole review unreadable.
 */
export function parseHunk(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;

  for (const line of patch.split('\n')) {
    const header = HEADER.exec(line);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[3]);
      rows.push({ kind: 'meta', oldNo: null, newNo: null, text: line, changed: [] });
      continue;
    }
    const marker = line[0];
    if (marker === '+') {
      rows.push({ kind: 'add', oldNo: null, newNo: newNo++, text: line.slice(1), changed: [] });
    } else if (marker === '-') {
      rows.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1), changed: [] });
    } else if (marker === '\\') {
      // "\ No newline at end of file" — git's note about the line above, not
      // a line of the file. It numbers nothing.
      rows.push({ kind: 'meta', oldNo: null, newNo: null, text: line, changed: [] });
    } else {
      // A context line, including the empty string git writes for a blank one.
      rows.push({
        kind: 'ctx', oldNo: oldNo++, newNo: newNo++,
        text: marker === ' ' ? line.slice(1) : line, changed: [],
      });
    }
  }

  return markWordChanges(rows);
}

// ---------------------------------------------------------------------------
// Within-line differences
// ---------------------------------------------------------------------------

/**
 * Fill in `changed` for removed/added lines that are plausibly the same line
 * edited.
 *
 * Lines are paired by position within the removed and added runs, up to the
 * length of the shorter one — "edited this line and added one after it" is
 * one of the most common shapes a diff takes, and refusing to pair unequal
 * runs would give up on it.
 *
 * What keeps that honest is the similarity gate rather than the pairing:
 * a pair is compared only if the two lines already look like one line edited.
 * Running a word diff over two unrelated lines marks nearly every token,
 * which reads as a rendering fault rather than as information, and lines that
 * merely landed next to each other in a hunk get nothing.
 */
function markWordChanges(rows: DiffRow[]): DiffRow[] {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.kind !== 'del') continue;

    let delEnd = i;
    while (delEnd < rows.length && rows[delEnd]!.kind === 'del') delEnd++;
    let addEnd = delEnd;
    while (addEnd < rows.length && rows[addEnd]!.kind === 'add') addEnd++;

    const pairs = Math.min(delEnd - i, addEnd - delEnd);
    for (let k = 0; k < pairs; k++) {
      const before = rows[i + k]!;
      const after = rows[delEnd + k]!;
      if (!similarEnough(before.text, after.text)) continue;
      const [left, right] = wordRanges(before.text, after.text);
      before.changed = left;
      after.changed = right;
    }
    i = Math.max(delEnd, addEnd) - 1;
  }
  return rows;
}

/**
 * Do these two lines look like one line edited, rather than two unrelated
 * lines that happen to sit next to each other in a diff? Measured on the
 * shared head and tail, which is what a real edit leaves behind.
 */
function similarEnough(a: string, b: string): boolean {
  if (!a.trim() || !b.trim()) return false;
  const longest = Math.max(a.length, b.length);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix && suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;
  return (prefix + suffix) / longest >= 0.3;
}

/** Words, punctuation and whitespace runs, each with where it starts. */
const WORD = /\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g;

interface Word { text: string; start: number }

function words(line: string): Word[] {
  const out: Word[] = [];
  WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD.exec(line)) !== null) out.push({ text: m[0], start: m.index });
  return out;
}

/**
 * Longest common subsequence over words, cheap enough at line scale.
 *
 * The cap is a guard against a machine-generated line — a minified bundle, a
 * base64 blob — turning an O(n·m) table into a frozen tab. Past it we simply
 * decline to say what changed within the line, which is the honest answer.
 */
const MAX_WORDS = 400;

function wordRanges(before: string, after: string): [Range[], Range[]] {
  const a = words(before);
  const b = words(after);
  if (a.length > MAX_WORDS || b.length > MAX_WORDS) return [[], []];

  // table[i][j] = LCS length of a[i..] and b[j..]
  const table: number[][] = Array.from(
    { length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i]!.text === b[j]!.text
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const left: Range[] = [];
  const right: Range[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]!.text === b[j]!.text) { i++; j++; continue; }
    if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      left.push([a[i]!.start, a[i]!.start + a[i]!.text.length]);
      i++;
    } else {
      right.push([b[j]!.start, b[j]!.start + b[j]!.text.length]);
      j++;
    }
  }
  for (; i < a.length; i++) left.push([a[i]!.start, a[i]!.start + a[i]!.text.length]);
  for (; j < b.length; j++) right.push([b[j]!.start, b[j]!.start + b[j]!.text.length]);

  return [merge(left), merge(right)];
}

/** Join ranges that touch, so a changed word is one span and not five. */
function merge(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const [start, end] of ranges) {
    const last = out[out.length - 1];
    if (last && last[1] >= start) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Painting a row
// ---------------------------------------------------------------------------

/**
 * Syntax tokens for one diff row, with the changed parts flagged.
 *
 * Two independent ways of cutting the same line — by syntax, and by what
 * changed — have to end up as one list of spans, so the syntax tokens are
 * split wherever a changed range starts or ends and the extra class is added
 * to the pieces that fall inside one.
 *
 * The highlighting here is per line, unlike the file viewer's: a hunk starts
 * in the middle of a file, so there is no way to know whether its first line
 * is inside a block comment. Colour that is right within the line is worth
 * having; colour that claims to know more than the hunk does is not.
 */
export function paintRow(row: DiffRow, path: string, extraClass: string): Token[] {
  const tokens = row.text === '' ? [] : (highlight(row.text, path)[0] ?? []);
  if (row.changed.length === 0) return tokens;

  const out: Token[] = [];
  let at = 0;
  for (const token of tokens) {
    const start = at;
    at += token.text.length;
    // Cut this token at every boundary that falls inside it.
    const cuts = new Set<number>([start, at]);
    for (const [from, to] of row.changed) {
      if (from > start && from < at) cuts.add(from);
      if (to > start && to < at) cuts.add(to);
    }
    const points = [...cuts].sort((x, y) => x - y);
    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i]!;
      const to = points[i + 1]!;
      const inside = row.changed.some(([s, e]) => from >= s && to <= e);
      out.push({
        text: row.text.slice(from, to),
        cls: [token.cls, inside ? extraClass : null].filter(Boolean).join(' ') || null,
      });
    }
  }
  return out;
}
