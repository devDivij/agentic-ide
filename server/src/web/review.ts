/**
 * Human-in-the-loop review: turn a finished task into hunks a person can
 * accept or reject individually, then apply exactly the accepted subset.
 *
 * The diff parser is hand-written because the unified-diff format is small
 * and stable, and we need one thing no general parser gives us: each hunk
 * carries the plan step that produced it, which is what lets the agent
 * "continue correctly around the rejected parts".
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { SHADOW_GIT_CONFIG } from '../agent/checkpoints.ts';
import { Store } from '../agent/store.ts';
import type { StepRecord } from '../agent/types.ts';
import type { DiffHunk, ReviewBundle } from '../shared/types.ts';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

export interface ParsedHunk {
  /** Stable across re-reads of the same diff, so UI selection survives refresh. */
  id: string;
  file: string;
  /** The `diff --git` header block this hunk belongs under; needed to re-apply. */
  fileHeader: string;
  /** The `@@ ... @@` block, verbatim. */
  body: string;
  touchesTests: boolean;
}

const TEST_PATTERN = /(^|\/)(tests?|__tests__|spec)\//i;
const TEST_FILENAME = /(^|\/)(test_[^/]+|[^/]+_test|[^/]+\.test|[^/]+\.spec)\.[a-z]+$/i;

export function looksLikeTest(path: string): boolean {
  return TEST_PATTERN.test(path) || TEST_FILENAME.test(path);
}

/**
 * Split a unified diff into per-hunk records. Tolerant by design: a malformed
 * section is skipped rather than throwing, so one odd file cannot make an
 * entire review unavailable.
 */
export function parseDiff(diff: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  if (!diff.trim()) return hunks;

  // Split on file boundaries, keeping the `diff --git` line with its section.
  const sections = diff.split(/^(?=diff --git )/m).filter((s) => s.trim());

  for (const section of sections) {
    const lines = section.split('\n');
    const path = lines[0]?.match(/^diff --git a\/(.+?) b\/(.+)$/)?.[2];
    if (!path) continue;

    const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
    if (firstHunk === -1) continue;   // pure rename/mode change: no hunks
    const fileHeader = lines.slice(0, firstHunk).join('\n');

    let current: string[] = [];
    const flush = (): void => {
      if (current.length === 0) return;
      const body = current.join('\n');
      hunks.push({
        id: createHash('sha1').update(`${path}\n${body}`).digest('hex').slice(0, 12),
        file: path,
        fileHeader,
        body,
        touchesTests: looksLikeTest(path),
      });
      current = [];
    };
    for (const line of lines.slice(firstHunk)) {
      if (line.startsWith('@@')) flush();
      current.push(line);
    }
    flush();
  }
  return hunks;
}

/**
 * Rebuild a patch containing only the selected hunks, regrouped under their
 * file headers (git apply needs the `diff --git` / `---` / `+++` preamble).
 * The `@@` line counts stay untouched: each hunk is positioned independently
 * and git applies with context matching.
 */
export function buildPatch(hunks: ParsedHunk[], selectedIds: Set<string>): string {
  const chosen = hunks.filter((h) => selectedIds.has(h.id));
  if (chosen.length === 0) return '';

  const byFile = new Map<string, ParsedHunk[]>();
  for (const hunk of chosen) {
    byFile.set(hunk.file, [...(byFile.get(hunk.file) ?? []), hunk]);
  }

  const parts: string[] = [];
  for (const [, fileHunks] of byFile) {
    parts.push(fileHunks[0]!.fileHeader);
    for (const hunk of fileHunks) parts.push(hunk.body);
  }
  return parts.join('\n').replace(/\n*$/, '\n');
}

// ---------------------------------------------------------------------------
// Building and applying a review
// ---------------------------------------------------------------------------

/**
 * The base..final checkpoint pair this task ran between, from its events.
 *
 * When the `final` marker is missing — an interrupted task, or one recorded
 * before that marker existed — fall back to the shadow repo's current HEAD.
 * Requiring both markers meant such a task rendered as "no file changes",
 * which is indistinguishable to a user from a broken review screen and is a
 * lie whenever the task did in fact write something.
 */
async function checkpointRange(
  db: Store, projectRoot: string, taskId: string,
): Promise<{ baseSha: string; headSha: string; approximate: boolean } | null> {
  let baseSha: string | null = null;
  let headSha: string | null = null;
  for (const ev of db.getEvents(taskId)) {
    if (ev.kind !== 'checkpoint') continue;
    const p = ev.payload as { sha?: string; label?: string };
    if (p.label === 'baseline' && p.sha && !baseSha) baseSha = p.sha;
    if (p.label === 'final' && p.sha) headSha = p.sha;
  }
  if (!baseSha) return null;
  if (headSha) return { baseSha, headSha, approximate: false };

  try {
    const { stdout } = await git(projectRoot, ['rev-parse', 'HEAD']);
    return { baseSha, headSha: stdout.trim(), approximate: true };
  } catch {
    return null;
  }
}

/**
 * Attribute each hunk to the plan step that produced it — by file, using the
 * last step that reported touching it. Approximate, and honestly so; the
 * file-level answer already supports the case that matters (knowing which
 * steps a rejection affects).
 */
function attributeToSteps(db: Store, taskId: string): Map<string, string> {
  const fileToStep = new Map<string, string>();
  for (const ev of db.getEvents(taskId)) {
    if (ev.kind !== 'tool_call' || !ev.stepId) continue;
    const p = ev.payload as { result?: { filesTouched?: string[] } };
    for (const file of p.result?.filesTouched ?? []) fileToStep.set(file, ev.stepId);
  }
  return fileToStep;
}

/**
 * Every step reachable from `seedIds` by following `dependsOn` forward — the
 * steps built ON TOP of a rejected one, transitively. A step two levels down
 * that assumed the rejected content is just as stale as the one right above
 * it; `applySelection` decides which of these actually need resetting (only
 * the ones currently 'done' represent committed work).
 */
export function blastRadius(steps: StepRecord[], seedIds: string[]): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const s of steps) {
    for (const dep of s.spec.dependsOn) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(s.stepId);
    }
  }
  const radius = new Set(seedIds);
  const queue = [...seedIds];
  while (queue.length > 0) {
    for (const dependent of dependents.get(queue.shift()!) ?? []) {
      if (!radius.has(dependent)) { radius.add(dependent); queue.push(dependent); }
    }
  }
  return radius;
}

export async function buildReview(
  projectRoot: string, taskId: string,
): Promise<ReviewBundle & { hunksRaw: ParsedHunk[] }> {
  const db = new Store(projectRoot);
  try {
    const range = await checkpointRange(db, projectRoot, taskId);
    if (!range) return { taskId, hunks: [], fullDiff: '', hunksRaw: [] };

    const fullDiff = await gitDiff(projectRoot, range.baseSha, range.headSha);
    const parsed = parseDiff(fullDiff);
    const stepOf = attributeToSteps(db, taskId);

    const hunks: DiffHunk[] = parsed.map((h) => ({
      id: h.id,
      file: h.file,
      patch: h.body,
      stepId: stepOf.get(h.file) ?? '',
      touchesTests: h.touchesTests,
    }));
    return { taskId, hunks, fullDiff, hunksRaw: parsed };
  } finally {
    db.close();
  }
}

/**
 * Apply exactly the accepted hunks to the working tree.
 *
 * The tree already contains ALL the agent's changes, so applying "the
 * accepted subset" on top would be a no-op. Instead: reset the touched files
 * to the pre-task baseline (only those files — the user's own new files are
 * none of our business), then apply the accepted hunks as a patch.
 */
export interface ApplySelectionResult {
  applied: number;
  rejected: number;
  files: string[];
  /**
   * Steps whose rejected hunk sent them back to 'pending' — what a resume
   * will re-attempt. Empty when every hunk was accepted, or a rejected hunk
   * could not be attributed back to a step (attributeToSteps found no
   * matching tool_call — rare, and there is nothing to requeue in that case).
   */
  requeuedSteps: string[];
}

export async function applySelection(
  projectRoot: string, taskId: string, acceptedIds: string[], feedback?: string,
): Promise<ApplySelectionResult> {
  const review = await buildReview(projectRoot, taskId);
  const db = new Store(projectRoot);
  try {
    const range = await checkpointRange(db, projectRoot, taskId);
    if (!range) throw new Error('That task has no reviewable checkpoint range.');

    const accepted = new Set(acceptedIds);
    const patch = buildPatch(review.hunksRaw, accepted);

    // Reset only the files this task touched back to the baseline.
    const touched = [...new Set(review.hunksRaw.map((h) => h.file))];
    for (const file of touched) {
      try {
        await git(projectRoot, ['checkout', range.baseSha, '--', file]);
      } catch {
        // Absent at baseline (the task created it): reverting means removing it.
        await git(projectRoot, ['rm', '-f', '--ignore-unmatch', '--', file])
          .catch(() => undefined);
      }
    }

    if (patch.trim()) {
      const dir = await mkdtemp(join(tmpdir(), 'agentzero-patch-'));
      try {
        const patchFile = join(dir, 'selection.patch');
        await writeFile(patchFile, patch, 'utf8');
        // --3way lets git fall back to a merge when context has drifted, which
        // is exactly the situation a partial selection creates.
        await git(projectRoot, ['apply', '--3way', '--whitespace=nowarn', patchFile]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    // A rejected hunk is not just a discarded diff — its step gets a real
    // do-over. Reset to 'pending' so a resume re-attempts it, and carry the
    // human's own words in as a fact if they left any: the same mechanic
    // already proven for tool-call approvals (ApprovalDecision.feedback) — a
    // bare rejection tells the model nothing, so it tends to redo the exact
    // thing that was just turned down.
    const rejectedSteps = [...new Set(
      review.hunks.filter((h) => !accepted.has(h.id) && h.stepId).map((h) => h.stepId))];
    // Doc §15's guard: "re-run blast radius". A step that already completed
    // ON TOP of the rejected change is built on ground that is about to move
    // — leaving it 'done' would let its checkpoint quietly outlive the work
    // it depended on. Only 'done' dependents are pulled in: a 'pending' one
    // hasn't run yet, and a 'skipped' one is already accounted for.
    const allSteps = db.getSteps(taskId);
    const requeuedSteps = [...blastRadius(allSteps, rejectedSteps)].filter((id) =>
      rejectedSteps.includes(id) || allSteps.find((s) => s.stepId === id)?.status === 'done');
    for (const stepId of requeuedSteps) {
      const existing = allSteps.find((s) => s.stepId === stepId);
      if (!existing) continue;
      db.upsertStep({ ...existing, status: 'pending', checkpointSha: null, attempts: 0 });
      // The feedback was about the specific rejected hunk, not generically
      // about everything downstream of it — attach it only there.
      if (feedback?.trim() && rejectedSteps.includes(stepId)) {
        db.addFacts(
          taskId, stepId, [`Human feedback on the rejected change: ${feedback.trim()}`]);
      }
    }
    // Marks the task resumable even if nothing auto-resumes it: this is the
    // same status the codebase already uses to mean "more to do, no live
    // session running it" (see `resumable` on the task-list endpoint).
    if (requeuedSteps.length > 0) db.setStatus(taskId, 'running');

    const files = [...new Set(
      review.hunksRaw.filter((h) => accepted.has(h.id)).map((h) => h.file))];
    return {
      applied: accepted.size,
      rejected: review.hunksRaw.length - accepted.size,
      files,
      requeuedSteps,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------

async function gitDiff(root: string, from: string, to: string): Promise<string> {
  const { stdout } = await git(root, ['diff', '--no-color', '--unified=3', from, to]);
  return stdout;
}

/** Same shadow-repo invocation the runtime uses; see agent/checkpoints.ts. */
function git(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec('git', [
    ...SHADOW_GIT_CONFIG,
    '--git-dir', join(root, '.agentzero', 'shadow.git'),
    '--work-tree', root,
    ...args,
  ], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
}
