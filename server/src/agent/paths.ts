/**
 * Path confinement: every path the agent (or the browser) names is resolved
 * against the project root and rejected if it escapes.
 *
 * The subtlety: `path.resolve()` normalises `..` LEXICALLY and knows nothing
 * about symlinks, so `project/link -> /etc/passwd` passes a prefix check while
 * actually reading outside the project. We therefore also resolve symlinks
 * (realpath) before comparing — walking up to the deepest ancestor that
 * exists, because a path being *written* may not exist yet.
 */

import { realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export class PathEscapeError extends Error {
  constructor(readonly attempted: string) {
    super(`Path '${attempted}' resolves outside the project root`);
    this.name = 'PathEscapeError';
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/** realpath of the deepest existing ancestor of `p`, with the rest re-appended. */
async function realpathOfNearestExisting(p: string): Promise<string> {
  let current = p;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return suffix.length > 0 ? resolve(real, ...suffix.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return p;   // reached the filesystem root
      suffix.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

/**
 * Resolve `candidate` against `root`; throw if it escapes. Checked twice:
 * lexically (cheap, catches `../..`), then after resolving symlinks.
 */
export async function confinePath(root: string, candidate: string): Promise<string> {
  const realRoot = await realpathOfNearestExisting(resolve(root));
  const lexical = resolve(realRoot, candidate);
  if (!isInside(realRoot, lexical)) throw new PathEscapeError(candidate);

  const real = await realpathOfNearestExisting(lexical);
  if (!isInside(realRoot, real)) throw new PathEscapeError(candidate);

  return lexical;
}

/** Variant for callers that treat an escape as "no result" (e.g. retrieval). */
export async function confinePathOrNull(root: string, candidate: string): Promise<string | null> {
  try {
    return await confinePath(root, candidate);
  } catch {
    return null;
  }
}
