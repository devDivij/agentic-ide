/**
 * Getting structured data out of small-model replies.
 *
 * Malformed structured output is the single most common failure mode of small
 * models — a chatty preamble, a code fence, a flattened object. This file is
 * the tolerance layer: extract the JSON however it was wrapped, and normalise
 * the shapes models actually emit into the one we asked for, so a model that
 * got the intent right but the shape slightly wrong does not cost a retry.
 */

import { z } from 'zod';

/** Pull a JSON object out of a reply that may wrap it in prose or fences. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  // Last resort: the outermost balanced {...}.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const parsed = tryParse(trimmed.slice(start, end + 1));
    if (parsed !== undefined) return parsed;
  }

  throw new Error('No JSON object found in model output');
}

function tryParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Compact, model-readable description of a validation failure, for the repair turn. */
export function describeZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

/**
 * Normalise an executor turn into the flat canonical shape.
 *
 * The executor schema is deliberately FLAT (see workers.ts): given a nested
 * shape like {"toolCall": {"tool": "read_file", "args": {...}}}, a 30B model
 * reliably flattened it to {"toolCall": "read_file", "args": "calc.py"} — not
 * as a slip but as its stable idea of the shape, so repair loops never
 * converged. Every branch below is a shape observed from a real model.
 */
export function coerceTurn(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const o = { ...(raw as Record<string, unknown>) };

  // Terminal state arriving nested: {"done": {...}}
  const done = o.done as Record<string, unknown> | null | undefined;
  if (done && typeof done === 'object') {
    return dropUndefined({
      thought: o.thought ?? '',
      action: done.outcome === 'blocked' ? 'blocked' : 'done',
      summary: done.summary ?? '',
      filesTouched: done.filesTouched ?? [],
      newFacts: done.newFacts ?? [],
      blockedReason: done.blockedReason,
    });
  }

  // The tool name, wherever the model decided to put it.
  const call = o.toolCall ?? o.tool_call ?? o.tool ?? o.action;
  let name: unknown = call;
  let args: Record<string, unknown> = {};

  if (call && typeof call === 'object') {
    const c = call as Record<string, unknown>;
    name = c.tool ?? c.name ?? c.action;
    if (c.args && typeof c.args === 'object') args = c.args as Record<string, unknown>;
  }
  if (typeof name !== 'string' || !name) return o;

  // A sibling `args` may be an object or a bare string ("calc.py").
  const siblingArgs = o.args;
  if (siblingArgs && typeof siblingArgs === 'object') {
    args = { ...args, ...(siblingArgs as Record<string, unknown>) };
  } else if (typeof siblingArgs === 'string') {
    args = { ...args, [mainArgFor(name)]: siblingArgs };
  }

  return dropUndefined({
    thought: o.thought ?? '',
    action: name,
    path: o.path ?? args.path,
    content: o.content ?? args.content,
    query: o.query ?? args.query,
    command: o.command ?? args.command,
    summary: o.summary,
    filesTouched: o.filesTouched,
    newFacts: o.newFacts,
    blockedReason: o.blockedReason,
  });
}

function dropUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

/** The argument a bare string most likely refers to, per tool. */
function mainArgFor(tool: string): string {
  switch (tool) {
    case 'search_code': return 'query';
    case 'run_command': return 'command';
    default:            return 'path';
  }
}
