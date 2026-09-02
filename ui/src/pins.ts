/**
 * Manual context control: the client-side half of `@path` / `@path:12-40`
 * pin tags.
 *
 * There is no structured "pinned files" field on the task-create API — the
 * server learns what you pinned by re-parsing these tags out of the prompt
 * string it already gets (`orchestrator.parse_pin_tags`). So this module's
 * job is narrow but load-bearing: stay byte-for-byte in sync with that
 * server-side regex, so a chip shown here is a pin the server actually loads.
 *
 * Mirrors `_PIN_TAG` in agent/orchestrator.py:
 *   @([A-Za-z0-9_\-./]+?)(?::(\d+)(?:-(\d+))?)?(?=[\s,;)]|$)
 */

export interface PinRef {
  path: string;
  startLine?: number;
  endLine?: number;
}

const PIN_TAG = /@([A-Za-z0-9_\-./]+?)(?::(\d+)(?:-(\d+))?)?(?=[\s,;)]|$)/g;

/** True when `path` can round-trip through an `@path` tag at all. */
export function isPinnablePath(path: string): boolean {
  return /^[A-Za-z0-9_\-./]+$/.test(path);
}

export function parsePinTags(text: string): PinRef[] {
  const out: PinRef[] = [];
  for (const m of text.matchAll(PIN_TAG)) {
    const path = m[1]!;
    const start = m[2] ? Number(m[2]) : undefined;
    const end = m[3] ? Number(m[3]) : start;
    out.push(start !== undefined ? { path, startLine: start, endLine: end } : { path });
  }
  return out;
}

/** Stable identity for dedup: same file+range is the same pin. */
export function pinKey(p: PinRef): string {
  return `${p.path}:${p.startLine ?? ''}-${p.endLine ?? ''}`;
}

export function samePin(a: PinRef, b: PinRef): boolean {
  return pinKey(a) === pinKey(b);
}

/** The literal tag text the server's parser expects, e.g. `@src/a.py:12-40`. */
export function pinTag(p: PinRef): string {
  if (p.startLine === undefined) return `@${p.path}`;
  const range = p.endLine !== undefined && p.endLine !== p.startLine
    ? `${p.startLine}-${p.endLine}` : `${p.startLine}`;
  return `@${p.path}:${range}`;
}

/** Short human label for a chip, e.g. `a.py:12-40` (basename, not full path). */
export function pinLabel(p: PinRef): string {
  const base = p.path.split('/').pop() ?? p.path;
  if (p.startLine === undefined) return base;
  const range = p.endLine !== undefined && p.endLine !== p.startLine
    ? `${p.startLine}-${p.endLine}` : `${p.startLine}`;
  return `${base}:${range}`;
}

export type PromptToken = { text: string; pin: PinRef | null };

/**
 * Split a message into plain text and `@path[:12-40]` references, so the
 * output chat can render the same tags the input box accepts as clickable
 * pin/unpin controls (spec: both directions need this, not just the input).
 */
export function tokenizePrompt(text: string): PromptToken[] {
  const out: PromptToken[] = [];
  let cursor = 0;
  for (const m of text.matchAll(PIN_TAG)) {
    const start = m.index ?? 0;
    if (start > cursor) out.push({ text: text.slice(cursor, start), pin: null });
    const path = m[1]!;
    const s = m[2] ? Number(m[2]) : undefined;
    const e = m[3] ? Number(m[3]) : s;
    const pin: PinRef = s !== undefined ? { path, startLine: s, endLine: e } : { path };
    out.push({ text: m[0], pin });
    cursor = start + m[0].length;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), pin: null });
  return out;
}

/**
 * Add a pin, deduping by identity. A second click of "Reference file" on the
 * same selection is a no-op here instead of a second `@tag` in the prompt.
 */
export function addPin(pins: PinRef[], next: PinRef): PinRef[] {
  return pins.some((p) => samePin(p, next)) ? pins : [...pins, next];
}

export function removePin(pins: PinRef[], target: PinRef): PinRef[] {
  return pins.filter((p) => !samePin(p, target));
}

export function togglePin(pins: PinRef[], target: PinRef): PinRef[] {
  return pins.some((p) => samePin(p, target)) ? removePin(pins, target) : addPin(pins, target);
}

/**
 * The prompt actually sent to the server: the draft, plus one `@tag` per
 * tray pin that is not already spelled out in the draft by hand.
 */
export function withPinTags(draft: string, pins: PinRef[]): string {
  if (pins.length === 0) return draft;
  const already = new Set(parsePinTags(draft).map(pinKey));
  const toAppend = pins.filter((p) => !already.has(pinKey(p)));
  if (toAppend.length === 0) return draft;
  const tags = toAppend.map(pinTag).join(' ');
  return draft.trim() ? `${draft}\n\n${tags}` : tags;
}
