/**
 * Offline test suite for the agent runtime's pure logic. No network, no model
 * calls, no API keys — `npm test` must pass on a clean machine.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { coerceTurn, extractJson } from '../src/agent/parse.ts';
import { normalisePlan, singleStepPlan } from '../src/agent/workers.ts';
import {
  classifyInCode, collectLinks, composeReport, countChangedFiles, orderSteps,
  requestStop,
  parsePinTags, TAXONOMY, toToolCall,
} from '../src/agent/orchestrator.ts';
import {
  BUDGETS, RateBucket, Router, isPayingWorthIt, scoreTask, SECONDS_PER_USD,
} from '../src/agent/router.ts';
import { buildContext } from '../src/agent/context.ts';
import { blastRadius, buildPatch, parseDiff } from '../src/web/review.ts';
// The UI's pure modules: no DOM, no React, so they run here rather than
// having no tests at all for the sake of which folder they live in.
import { diffFiles, parseHunk, paintRow } from '../../ui/src/diff.ts';
import { highlight } from '../../ui/src/highlight.ts';
import { initialState, reduce } from '../../ui/src/state.ts';
import type { ServerEvent, TraceNode } from '../src/shared/types.ts';
import { confinePath, PathEscapeError, toPosix } from '../src/agent/paths.ts';
import { shellInvocation } from '../src/agent/shell.ts';
import { checkFileSyntax } from '../src/agent/verify.ts';
import { findUrl, runTool, scrubEnvironment } from '../src/agent/tools.ts';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/agent/store.ts';
import type { PlanStep, Task } from '../src/agent/types.ts';

// ---------------------------------------------------------------------------
// parse.ts — JSON extraction and turn coercion
// ---------------------------------------------------------------------------

test('extractJson: direct, fenced, and prose-wrapped objects', () => {
  assert.deepEqual(extractJson('{"a": 1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(
    extractJson('Sure! Here is the plan: {"a": {"b": 2}} hope that helps'),
    { a: { b: 2 } });
  assert.throws(() => extractJson('no json here at all'));
});

test('coerceTurn: nested toolCall form is flattened', () => {
  const turn = coerceTurn({
    thought: 't',
    toolCall: { tool: 'read_file', args: { path: 'x.py' } },
  }) as Record<string, unknown>;
  assert.equal(turn.action, 'read_file');
  assert.equal(turn.path, 'x.py');
  assert.equal(turn.thought, 't');
});

test('coerceTurn: bare-string args maps to the tool\'s main argument', () => {
  const read = coerceTurn({ toolCall: 'read_file', args: 'calc.py' }) as Record<string, unknown>;
  assert.equal(read.action, 'read_file');
  assert.equal(read.path, 'calc.py');

  const search = coerceTurn({ tool: 'search_code', args: 'multiply' }) as Record<string, unknown>;
  assert.equal(search.action, 'search_code');
  assert.equal(search.query, 'multiply');
});

test('coerceTurn: nested done/blocked forms become terminal actions', () => {
  const done = coerceTurn({
    done: { outcome: 'completed', summary: 's', filesTouched: ['a.py'] },
  }) as Record<string, unknown>;
  assert.equal(done.action, 'done');
  assert.deepEqual(done.filesTouched, ['a.py']);

  const blocked = coerceTurn({
    done: { outcome: 'blocked', blockedReason: 'missing file' },
  }) as Record<string, unknown>;
  assert.equal(blocked.action, 'blocked');
  assert.equal(blocked.blockedReason, 'missing file');
});

test('coerceTurn: the canonical flat form passes through unchanged', () => {
  const turn = coerceTurn({
    thought: 'w', action: 'run_command', command: 'ls',
  }) as Record<string, unknown>;
  assert.equal(turn.action, 'run_command');
  assert.equal(turn.command, 'ls');
});

// ---------------------------------------------------------------------------
// workers.ts — plan normalisation
// ---------------------------------------------------------------------------

function step(partial: Partial<PlanStep> & { id: string }): PlanStep {
  return {
    intent: 'do something', targetFiles: [], acceptanceCriteria: ['x'],
    dependsOn: [], difficulty: 'routine', ...partial,
  };
}

test('normalisePlan: duplicate ids, dangling/self/forward deps, empty criteria', () => {
  const plan = normalisePlan({
    summary: 's',
    steps: [
      step({ id: 's1', dependsOn: ['s2'], acceptanceCriteria: [] }),   // forward dep
      step({ id: 's2', dependsOn: ['s2'] }),                            // self dep
      step({ id: 's2', dependsOn: ['s1'] }),                            // duplicate id
      step({ id: 's3', dependsOn: ['s9', 's1'] }),                      // dangling dep
    ],
  });
  assert.deepEqual(plan.steps.map((s) => s.id), ['s1', 's2', 's2b', 's3']);
  assert.deepEqual(plan.steps[0]!.dependsOn, []);          // forward edge removed
  assert.deepEqual(plan.steps[1]!.dependsOn, []);          // self edge removed
  assert.deepEqual(plan.steps[2]!.dependsOn, ['s1']);      // valid backward edge kept
  assert.deepEqual(plan.steps[3]!.dependsOn, ['s1']);      // dangling s9 removed
  assert.ok(plan.steps[0]!.acceptanceCriteria.length > 0); // criteria filled in
});

// ---------------------------------------------------------------------------
// orchestrator.ts — ordering, pin tags, tool mapping
// ---------------------------------------------------------------------------

test('orderSteps: topological order over dependsOn', () => {
  const ordered = orderSteps([
    step({ id: 'b', dependsOn: ['a'] }),
    step({ id: 'a' }),
    step({ id: 'c', dependsOn: ['b'] }),
  ]);
  assert.deepEqual(ordered.map((s) => s.id), ['a', 'b', 'c']);
});

test('orderSteps: a cycle degrades to declaration order instead of deadlocking', () => {
  const ordered = orderSteps([
    step({ id: 'a', dependsOn: ['b'] }),
    step({ id: 'b', dependsOn: ['a'] }),
  ]);
  assert.deepEqual(ordered.map((s) => s.id), ['a', 'b']);
});

test('parsePinTags: @path, @path:12, @path:12-40, punctuation after tag', () => {
  assert.deepEqual(parsePinTags('fix @src/app.py please'),
    [{ path: 'src/app.py' }]);
  assert.deepEqual(parsePinTags('look at @a.py:12'),
    [{ path: 'a.py', startLine: 12, endLine: 12 }]);
  assert.deepEqual(parsePinTags('see @a.py:12-40 and @b.ts, thanks'),
    [{ path: 'a.py', startLine: 12, endLine: 40 }, { path: 'b.ts' }]);
});

test('toToolCall: maps each tool, defaults, and rejects unknown actions', () => {
  assert.deepEqual(toToolCall({ action: 'read_file', path: 'x.py' }),
    { name: 'read_file', args: { path: 'x.py' } });
  assert.deepEqual(toToolCall({ action: 'list_files' }),
    { name: 'list_files', args: { path: '.' } });
  assert.deepEqual(toToolCall({ action: 'search_code', query: 'q' }),
    { name: 'search_code', args: { query: 'q' } });
  assert.deepEqual(toToolCall({ action: 'write_file', path: 'a', content: 'c' }),
    { name: 'write_file', args: { path: 'a', content: 'c' } });
  assert.deepEqual(toToolCall({ action: 'run_command', command: 'ls' }),
    { name: 'run_command', args: { command: 'ls' } });
  assert.equal(toToolCall({ action: 'summon_demon' }), null);
});

// ---------------------------------------------------------------------------
// router.ts — scoring, pay-vs-wait, rate buckets, ranking
// ---------------------------------------------------------------------------

test('scoreTask: perfect free instant task scores 10; hard limits score 0', () => {
  assert.equal(scoreTask(1, 0, 0), 10);
  assert.equal(scoreTask(1, 0.6, 100), 0);    // over $0.50
  assert.equal(scoreTask(1, 0.1, 3000), 0);   // over 2700s
  assert.ok(scoreTask(1, 0.05, 300) > 0);
});

test('isPayingWorthIt: the derived exchange rate decides', () => {
  assert.equal(isPayingWorthIt(Infinity, 5), true);    // free never frees up
  assert.equal(isPayingWorthIt(0, 0), true);           // free is never worse
  // A 1000ms wait is worth ~$0.00006 — paying a cent for it is not.
  assert.equal(isPayingWorthIt(1000, 0.01), false);
  // A wait worth more than the price: pay.
  const waitMs = 2 * SECONDS_PER_USD * 1000;           // worth $2
  assert.equal(isPayingWorthIt(waitMs, 1), true);
});

test('RateBucket: request-count window blocks and then frees', () => {
  const t0 = 1_000_000;
  const bucket = new RateBucket('p', { requestsPerMinute: 2 });
  assert.equal(bucket.waitMs(10, t0), 0);
  bucket.record(100, t0);
  bucket.record(100, t0);
  assert.ok(bucket.waitMs(10, t0) > 0);                 // window full
  assert.equal(bucket.waitMs(10, t0 + 60_001), 0);      // oldest aged out
});

test('RateBucket: token windows, oversized calls, penalties, headroom', () => {
  const t0 = 1_000_000;
  const bucket = new RateBucket('p', { tokensPerDay: 1000 });
  bucket.record(900, t0);
  assert.equal(bucket.waitMs(50, t0), 0);               // still fits
  assert.ok(bucket.waitMs(200, t0) > 0);                // would exceed the day
  assert.equal(bucket.waitMs(2000, t0), Infinity);      // could never fit
  assert.equal(bucket.headroom(t0).tokensPerDay, 100);

  const penalized = new RateBucket('q', {});
  penalized.penalize(5000, t0);
  assert.equal(penalized.waitMs(10, t0), 5000);
  assert.equal(penalized.waitMs(10, t0 + 5001), 0);
});

test('Router.rank: default tier serves when it is all there is', () => {
  const router = new Router(new Set(['nvidia']));
  const ranked = router.rank({ role: 'plan', estimatedTokens: 100 });
  assert.ok(ranked.length > 0);
  assert.equal(ranked[0]!.provider.id, 'nvidia');
  // All nvidia plan models are free → strongest first (a 30B model here).
  assert.equal(ranked[0]!.model.totalParamsB, 30);
});

test('Router.rank: a user-configured provider demotes the default tier', () => {
  const router = new Router(new Set(['nvidia', 'groq']));
  const ranked = router.rank({ role: 'plan', estimatedTokens: 100 });
  assert.equal(ranked[0]!.provider.id, 'groq');
  const firstNvidia = ranked.findIndex((c) => c.provider.id === 'nvidia');
  const lastGroq = ranked.map((c) => c.provider.id).lastIndexOf('groq');
  assert.ok(firstNvidia > lastGroq, 'every groq model ranks above every nvidia model');
});

test('Router.rank: free before paid; hairy prefers strength among paid', () => {
  const router = new Router(new Set(['openrouter']));
  const routine = router.rank({ role: 'execute', estimatedTokens: 100 });
  assert.equal(routine[0]!.model.id, 'qwen/qwen3-coder:free');
  // Routine + paid → smallest capable model first.
  const paidRoutine = routine.filter((c) => c.model.costPerMTokIn > 0);
  assert.equal(paidRoutine[0]!.model.id, 'mistralai/devstral-small');

  const hairy = router.rank({ role: 'execute', estimatedTokens: 100, difficulty: 'hairy' });
  const paidHairy = hairy.filter((c) => c.model.costPerMTokIn > 0);
  assert.equal(paidHairy[0]!.model.id, 'qwen/qwen3-coder');
});

// ---------------------------------------------------------------------------
// context.ts — assembly and compaction
// ---------------------------------------------------------------------------

test('buildContext: fits → nothing dropped, contract rendered last', () => {
  const ctx = buildContext({
    role: 'execute', prompt: 'fix the bug', projectRules: 'use tabs',
    outputContract: 'THE-CONTRACT',
    facts: [{ id: 1, taskId: 't', text: 'a fact', stepId: 's1', createdAt: 0, purgedAt: null }],
  });
  assert.equal(ctx.compacted, false);
  assert.ok(ctx.messages[1]!.content.trimEnd().endsWith('THE-CONTRACT'));
  assert.ok(ctx.manifest.some((m) => m.kind === 'rules'));
});

test('buildContext: outcomes are dropped before chunks; pins never dropped', () => {
  // Budget for 'execute' is 32k * 0.6 = 19200 tokens (~4 chars/token).
  const bigChunk = {
    path: 'big.py', startLine: 1, endLine: 999,
    text: 'x'.repeat(60_000), reason: 'match',           // ~15k tokens
  };
  const pin = {
    path: 'pin.py', startLine: 1, endLine: 9,
    text: 'y'.repeat(8_000), reason: 'pinned',           // ~2k tokens
  };
  const ctx = buildContext({
    role: 'execute', prompt: 'p', projectRules: null,
    chunks: [bigChunk], pinned: [pin],
    recentOutcomes: ['o'.repeat(20_000)],                // ~5k tokens
  });
  assert.equal(ctx.compacted, true);
  assert.deepEqual(ctx.droppedKinds, ['outcomes']);      // dropped first, and enough
  assert.ok(ctx.manifest.some((m) => m.kind === 'chunk'));
  assert.ok(ctx.manifest.some((m) => m.kind === 'pin'));
});

// ---------------------------------------------------------------------------
// web/review.ts — diff parsing and selective patch rebuild
// ---------------------------------------------------------------------------

const DIFF = `diff --git a/src/calc.py b/src/calc.py
index 0000000..1111111 100644
--- a/src/calc.py
+++ b/src/calc.py
@@ -1,3 +1,3 @@
 def add(a, b):
-    return a - b
+    return a + b
@@ -10,2 +10,3 @@
 x = 1
+y = 2
diff --git a/tests/test_calc.py b/tests/test_calc.py
index 0000000..2222222 100644
--- a/tests/test_calc.py
+++ b/tests/test_calc.py
@@ -1,1 +1,2 @@
 import calc
+assert calc
`;

test('parseDiff: multi-file multi-hunk, test files flagged', () => {
  const hunks = parseDiff(DIFF);
  assert.equal(hunks.length, 3);
  assert.equal(hunks[0]!.file, 'src/calc.py');
  assert.equal(hunks[1]!.file, 'src/calc.py');
  assert.equal(hunks[2]!.file, 'tests/test_calc.py');
  assert.equal(hunks[0]!.touchesTests, false);
  assert.equal(hunks[2]!.touchesTests, true);
  // Ids are stable across re-parses of the same diff.
  assert.deepEqual(hunks.map((h) => h.id), parseDiff(DIFF).map((h) => h.id));
});

test('buildPatch: only selected hunks, grouped under their file headers', () => {
  const hunks = parseDiff(DIFF);
  const patch = buildPatch(hunks, new Set([hunks[0]!.id, hunks[2]!.id]));
  assert.ok(patch.includes('diff --git a/src/calc.py'));
  assert.ok(patch.includes('diff --git a/tests/test_calc.py'));
  assert.ok(patch.includes('@@ -1,3 +1,3 @@'));
  assert.ok(!patch.includes('@@ -10,2 +10,3 @@'));       // unselected hunk absent
  assert.equal(buildPatch(hunks, new Set()), '');
});

// ---------------------------------------------------------------------------
// paths.ts — confinement
// ---------------------------------------------------------------------------

test('confinePath: rejects escapes, lexical and via symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'az-confine-'));
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'sub', 'ok.txt'), 'hi');

  assert.equal(await confinePath(root, 'sub/ok.txt'), join(root, 'sub', 'ok.txt'));
  await assert.rejects(() => confinePath(root, '../outside.txt'), PathEscapeError);
  await assert.rejects(() => confinePath(root, '/etc/passwd'), PathEscapeError);

  // A symlink inside the project pointing outside it must not be followable.
  await symlink(tmpdir(), join(root, 'link'));
  await assert.rejects(() => confinePath(root, 'link/escape.txt'), PathEscapeError);
});

// ---------------------------------------------------------------------------
// tools.ts — environment scrubbing
// ---------------------------------------------------------------------------

test('scrubEnvironment: secret-shaped names removed, ordinary ones kept', () => {
  const scrubbed = scrubEnvironment({
    PATH: '/bin', HOME: '/home/u', JAVA_HOME: '/opt/java', NORMAL: 'ok',
    GROQ_API_KEY: 'g', MY_TOKEN: 't', DB_PASSWORD: 'p', AUTH_HEADER: 'a',
  });
  assert.equal(scrubbed.PATH, '/bin');
  assert.equal(scrubbed.HOME, '/home/u');
  assert.equal(scrubbed.JAVA_HOME, '/opt/java');
  assert.equal(scrubbed.NORMAL, 'ok');
  assert.ok(!('GROQ_API_KEY' in scrubbed));
  assert.ok(!('MY_TOKEN' in scrubbed));
  assert.ok(!('DB_PASSWORD' in scrubbed));
  assert.ok(!('AUTH_HEADER' in scrubbed));
});

// ---------------------------------------------------------------------------
// state.ts — what the browser shows, and which project it belongs to
// ---------------------------------------------------------------------------

const traceNode = (id: number, taskId: string): TraceNode => ({
  id, parentId: null, taskId, seq: id, ts: id, kind: 'step_start', role: null,
  stepId: null, payload: {}, model: null, provider: null,
  tokensIn: 0, tokensOut: 0, costUsd: 0, durationMs: 0, status: 'ok',
});

const summary = (id: string) => ({
  id, conversationId: 'c1', prompt: 'p', status: 'running' as const,
  complexity: 'easy' as const, createdAt: 1, costUsd: 0, tokens: 0, elapsedMs: 0,
});

const fed = (state: ReturnType<typeof initialState>, ...events: ServerEvent[]) =>
  events.reduce((acc, event) => reduce(acc, { type: 'event', event }), state);

test('state: a task still running in the project you left cannot reach the one you opened', () => {
  // The event bus is one process-wide stream. This is the whole reason
  // events carry a project root, and the bug it fixes: switching folders left
  // the previous project's task, trace and approvals in the new chat.
  const inA = fed(initialState('/proj/a'),
    { type: 'trace', projectRoot: '/proj/a', node: traceNode(1, 't1') },
    { type: 'task', projectRoot: '/proj/a', task: summary('t1') });
  assert.equal(inA.trace.length, 1);
  assert.equal(inA.task!.id, 't1');

  const inB = reduce(inA, { type: 'project', projectRoot: '/proj/b' });
  assert.deepEqual(inB.trace, []);
  assert.equal(inB.task, null);
  assert.deepEqual(inB.steps, []);
  assert.deepEqual(inB.approvals, []);
  assert.deepEqual(inB.logs, []);
  assert.equal(inB.projectRoot, '/proj/b');

  // ...and the old project keeps publishing. None of it lands here.
  const after = fed(inB,
    { type: 'trace', projectRoot: '/proj/a', node: traceNode(2, 't1') },
    { type: 'task', projectRoot: '/proj/a', task: summary('t1') },
    {
      type: 'approval_request', projectRoot: '/proj/a',
      request: { taskId: 't1', eventId: 9, toolName: 'run_command', args: {}, effect: 'x' },
    },
    { type: 'log', projectRoot: '/proj/a', taskId: 't1', level: 'error', message: 'from A' });
  assert.deepEqual(after.trace, []);
  assert.equal(after.task, null);
  assert.deepEqual(after.approvals, []);
  assert.deepEqual(after.logs, []);
});

test('state: re-opening the same project is not a reset', () => {
  // Reconnecting or re-confirming the current project must not wipe a task
  // that is running in it — the mount effect does exactly this on every load.
  const state = fed(initialState('/proj/a'),
    { type: 'trace', projectRoot: '/proj/a', node: traceNode(1, 't1') });
  const again = reduce(state, { type: 'project', projectRoot: '/proj/a' });
  assert.equal(again, state, 'same project: the very same state object');
});

test('state: an answer that belongs to no project is shown wherever you are', () => {
  // /bytheway is answered with zero task context and no project, so it is not
  // filtered — the alternative is an answer that silently never arrives.
  const state = reduce(initialState('/proj/a'), {
    type: 'event',
    event: {
      type: 'aside',
      aside: { question: 'q', answer: 'a', provider: 'p', model: 'm', costUsd: 0, ts: 7 },
    },
  });
  assert.equal(state.asides.length, 1);
});

test('state: the stream replays on connect, and replays must not duplicate', () => {
  const node = traceNode(1, 't1');
  const state = fed(initialState('/proj/a'),
    { type: 'trace', projectRoot: '/proj/a', node },
    { type: 'trace', projectRoot: '/proj/a', node });
  assert.equal(state.trace.length, 1);
});

// ---------------------------------------------------------------------------
// diff.ts — a hunk as a person reads it
// ---------------------------------------------------------------------------

const HUNK = [
  '@@ -10,4 +10,5 @@ function greet() {',
  ' const name = "world";',
  '-  console.log("hello " + name);',
  '+  console.log("goodbye " + name);',
  '+  return name;',
  ' }',
].join('\n');

test('parseHunk: numbers both sides and strips the marker from the code', () => {
  const rows = parseHunk(HUNK);

  assert.equal(rows[0]!.kind, 'meta');
  // Context: numbered on both sides, and the leading space is not code.
  assert.deepEqual(
    { kind: rows[1]!.kind, oldNo: rows[1]!.oldNo, newNo: rows[1]!.newNo },
    { kind: 'ctx', oldNo: 10, newNo: 10 });
  assert.equal(rows[1]!.text, 'const name = "world";');

  // A deletion advances only the old side, an addition only the new one.
  assert.deepEqual(
    { kind: rows[2]!.kind, oldNo: rows[2]!.oldNo, newNo: rows[2]!.newNo },
    { kind: 'del', oldNo: 11, newNo: null });
  assert.deepEqual(
    { kind: rows[3]!.kind, oldNo: rows[3]!.oldNo, newNo: rows[3]!.newNo },
    { kind: 'add', oldNo: null, newNo: 11 });
  assert.equal(rows[3]!.text, '  console.log("goodbye " + name);');

  // ...and the context line after them resumes from both counters.
  const tail = rows[5]!;
  assert.deepEqual({ old: tail.oldNo, new: tail.newNo }, { old: 12, new: 13 });
});

test('parseHunk: marks the words that changed inside an edited line', () => {
  const rows = parseHunk(HUNK);
  const removed = rows[2]!;
  const added = rows[3]!;

  const sliced = (row: typeof removed): string[] =>
    row.changed.map(([a, b]) => row.text.slice(a, b));

  // Only the word that actually differs, not the whole line.
  assert.deepEqual(sliced(removed), ['hello']);
  assert.deepEqual(sliced(added), ['goodbye']);
});

test('parseHunk: declines to word-diff lines that are merely adjacent', () => {
  // Two unrelated lines. Comparing them word by word would mark nearly
  // everything, which reads as a rendering fault rather than as information.
  const rows = parseHunk([
    '@@ -1,1 +1,1 @@',
    '-import { readFile } from "node:fs/promises";',
    '+const PORT = 4319;',
  ].join('\n'));
  assert.deepEqual(rows[1]!.changed, []);
  assert.deepEqual(rows[2]!.changed, []);
});

test('parseHunk: an unbalanced block pairs what it can and invents nothing', () => {
  // One line out, three in. The first added line is the edited one; the two
  // after it are new, and have nothing to be compared against.
  const rows = parseHunk([
    '@@ -1,1 +1,3 @@',
    '-  return a + b;',
    '+  return a + b + c;',
    '+  log(total);',
    '+  return total;',
  ].join('\n'));

  assert.deepEqual(
    rows[2]!.changed.map(([a, b]) => rows[2]!.text.slice(a, b)), [' + c']);
  assert.deepEqual(rows[3]!.changed, []);
  assert.deepEqual(rows[4]!.changed, []);
});

test('parseHunk: git\'s "no newline" note numbers nothing', () => {
  const rows = parseHunk([
    '@@ -1,1 +1,1 @@',
    '-old',
    '\\ No newline at end of file',
    '+new',
  ].join('\n'));
  const note = rows[2]!;
  assert.equal(note.kind, 'meta');
  assert.equal(note.oldNo, null);
  // The addition after it still numbers from the header, not from the note.
  assert.equal(rows[3]!.newNo, 1);
});

test('paintRow: syntax spans are split at the boundaries of what changed', () => {
  const rows = parseHunk(HUNK);
  const added = rows[3]!;
  const tokens = paintRow(added, 'greet.ts', 'word-add');

  // Losslessly re-renderable: the spans still spell the original line.
  assert.equal(tokens.map((t) => t.text).join(''), added.text);

  // The changed word is flagged, and keeps the string colour it sits inside.
  const flagged = tokens.filter((t) => t.cls?.includes('word-add'));
  assert.deepEqual(flagged.map((t) => t.text), ['goodbye']);
  assert.ok(flagged[0]!.cls!.includes('syn-str'));

  // Nothing outside the changed range is flagged.
  assert.ok(tokens.some((t) => t.text === 'name' && !t.cls?.includes('word-add')));
});

test('paintRow: an unknown extension still yields the line, uncoloured', () => {
  const rows = parseHunk('@@ -1,1 +1,1 @@\n+some text here');
  const tokens = paintRow(rows[1]!, 'notes.unknownext', 'word-add');
  assert.equal(tokens.map((t) => t.text).join(''), 'some text here');
});

// ---------------------------------------------------------------------------
// diff.ts — diffFiles: the approval prompt's before/after, no git involved
// ---------------------------------------------------------------------------

test('diffFiles: a brand-new file is all additions, and nothing is fetched to know that', () => {
  const rows = diffFiles(null, 'line one\nline two\n');
  assert.ok(rows.every((r) => r.kind === 'add'));
  assert.deepEqual(rows.map((r) => r.newNo), [1, 2, 3]);
  assert.deepEqual(rows.map((r) => r.oldNo), [null, null, null]);
});

test('diffFiles: an untouched file is all context, and lines keep their numbers', () => {
  const text = 'a\nb\nc\n';
  const rows = diffFiles(text, text);
  assert.ok(rows.every((r) => r.kind === 'ctx'));
  assert.deepEqual(rows.map((r) => [r.oldNo, r.newNo]), [[1, 1], [2, 2], [3, 3], [4, 4]]);
});

test('diffFiles: a one-line edit in a long file touches one line, not the whole file', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  const before = lines.join('\n');
  const after = lines.with(25, 'line 25 EDITED').join('\n');
  const rows = diffFiles(before, after);

  const changed = rows.filter((r) => r.kind !== 'ctx');
  assert.equal(changed.length, 2, 'exactly one removed line and one added line');
  assert.equal(changed[0]!.kind, 'del');
  assert.equal(changed[1]!.kind, 'add');
  assert.equal(changed[1]!.text, 'line 25 EDITED');

  // The word-level matcher still finds what changed within that one line —
  // including the space that separates the new word from what was there,
  // which is itself part of what got inserted.
  const addedWord = changed[1]!;
  const flagged = addedWord.changed.map(([a, b]) => addedWord.text.slice(a, b));
  assert.deepEqual(flagged, [' EDITED']);
});

test('diffFiles: inserting a line in the middle does not renumber it as an edit', () => {
  // Both texts end in a trailing newline, so `split('\n')` gives both an
  // extra trailing empty-line entry — real, and identical on both sides, so
  // it is the final context row rather than a diff of nothing against nothing.
  const rows = diffFiles('a\nb\nc\n', 'a\nb\nNEW\nc\n');
  const kinds = rows.map((r) => r.kind);
  assert.deepEqual(kinds, ['ctx', 'ctx', 'add', 'ctx', 'ctx']);
  assert.equal(rows[2]!.text, 'NEW');
  // A pure insertion has nothing to word-diff against.
  assert.deepEqual(rows[2]!.changed, []);
});

test('diffFiles: an empty file and an empty proposal is simply nothing', () => {
  assert.deepEqual(diffFiles('', ''), []);
});

test('diffFiles: two files with nothing in common past the size cap fall back honestly', () => {
  // Two large files sharing not one line: forces the size-cap fallback path
  // rather than the Myers search, and that fallback must still be a true
  // (if uncorrelated) picture — every old line removed, every new line added.
  const before = Array.from({ length: 700 }, (_, i) => `old-${i}`).join('\n');
  const after = Array.from({ length: 700 }, (_, i) => `new-${i}`).join('\n');
  const rows = diffFiles(before, after);

  assert.equal(rows.filter((r) => r.kind === 'del').length, 700);
  assert.equal(rows.filter((r) => r.kind === 'add').length, 700);
  assert.ok(rows.every((r) => r.kind === 'del' || r.kind === 'add'));
});

// ---------------------------------------------------------------------------
// highlight.ts — the tokenizer the viewer and the diff share
// ---------------------------------------------------------------------------

test('highlight: returns exactly one entry per line of the source', () => {
  const src = 'const a = 1;\n\n/* two\n   lines */\nconst b = 2;\n';
  assert.equal(highlight(src, 'x.ts').length, src.split('\n').length);
});

test('highlight: order of alternatives decides the hard cases', () => {
  // A `#` inside a string is string, and a keyword inside a comment is comment.
  const [line] = highlight('x = "# not a comment"  # real comment', 'a.py');
  const strings = line!.filter((t) => t.cls === 'syn-str').map((t) => t.text);
  assert.deepEqual(strings, ['"# not a comment"']);

  const [second] = highlight('// class Foo', 'a.ts');
  assert.deepEqual(second!.map((t) => t.cls), ['syn-com']);
});

// ---------------------------------------------------------------------------
// store.ts — the SQLite substrate
// ---------------------------------------------------------------------------

async function tempStore(): Promise<{ db: Store; task: Task }> {
  const dir = await mkdtemp(join(tmpdir(), 'az-store-'));
  const db = new Store(dir);
  const task: Task = {
    id: 'task-1', projectRoot: dir, conversationId: db.createConversation(dir, 'chat'),
    prompt: 'do the thing',
    status: 'running', complexity: 'medium', createdAt: Date.now(),
    budget: BUDGETS.medium,
  };
  db.createTask(task);
  return { db, task };
}

test('store: task roundtrip and status updates', async () => {
  const { db, task } = await tempStore();
  try {
    assert.deepEqual(db.getTask(task.id), task);
    db.setStatus(task.id, 'awaiting_review');
    assert.equal(db.getTask(task.id)!.status, 'awaiting_review');
    assert.equal(db.getTask('nope'), null);
  } finally {
    db.close();
  }
});

test('store: a pre-0.2 database keeps working, budgets and all', async () => {
  // Exactly the tasks table older builds created: five NOT NULL budget
  // columns, no budget_json. `CREATE TABLE IF NOT EXISTS` never touches it,
  // so without a migration the first insert dies on a missing column.
  const dir = await mkdtemp(join(tmpdir(), 'az-oldschema-'));
  await mkdir(join(dir, '.agentzero'), { recursive: true });
  const raw = new DatabaseSync(join(dir, '.agentzero', 'state.db'));
  raw.exec(`
    CREATE TABLE tasks (
      id             TEXT PRIMARY KEY,
      project_root   TEXT NOT NULL,
      prompt         TEXT NOT NULL,
      status         TEXT NOT NULL,
      complexity     TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      budget_usd     REAL NOT NULL,
      budget_seconds INTEGER NOT NULL,
      budget_tokens  INTEGER NOT NULL,
      budget_steps   INTEGER NOT NULL,
      budget_retries INTEGER NOT NULL,
      plan_json      TEXT,
      base_sha       TEXT
    );
    INSERT INTO tasks VALUES
      ('old-1', 'x', 'an older task', 'awaiting_review', 'medium', 1,
       0.06, 1200, 400000, 16, 2, NULL, NULL);
  `);
  raw.close();

  const db = new Store(dir);
  try {
    // The history survives, with the budget carried across intact.
    const old = db.getTask('old-1');
    assert.equal(old!.prompt, 'an older task');
    assert.deepEqual(old!.budget, BUDGETS.medium);

    // And the store accepts new work, which is what actually used to break.
    db.createTask({
      id: 'new-1', projectRoot: dir, conversationId: db.createConversation(dir, 'chat'),
      prompt: 'a new task', status: 'running',
      complexity: 'easy', createdAt: 2, budget: BUDGETS.easy,
    });
    assert.deepEqual(db.getTask('new-1')!.budget, BUDGETS.easy);

    // A database from before chats existed gets its history gathered into
    // one, rather than losing it: a task with no conversation belongs to no
    // chat, and the picker would simply never show it again.
    const gathered = db.getTask('old-1')!.conversationId;
    assert.ok(gathered, 'the old task was adopted into a conversation');
    assert.deepEqual(db.listConversationTasks(gathered).map((t) => t.id), ['old-1']);
    // Filed under the root the database was opened with, NOT under the
    // `project_root` the row records — the fixture above wrote 'x' there, and
    // a chat filed under 'x' is one the UI could never ask for. Exactly one,
    // however many times the store has been opened since.
    const titles = db.listConversations(dir).map((c) => c.title);
    assert.deepEqual(titles.filter((t) => t === 'Earlier work'), ['Earlier work']);
  } finally {
    db.close();
  }
});

test('store: a chat scopes its own tasks, and history is not one endless thread', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'az-chats-'));
  const db = new Store(dir);
  try {
    const first = db.createConversation(dir, 'add a parser');
    const second = db.createConversation(dir, 'fix the tests');
    db.createTask({
      id: 'a', projectRoot: dir, conversationId: first, prompt: 'one',
      status: 'done', complexity: 'easy', createdAt: 10, budget: BUDGETS.easy,
    });
    db.createTask({
      id: 'b', projectRoot: dir, conversationId: first, prompt: 'two',
      status: 'done', complexity: 'easy', createdAt: 20, budget: BUDGETS.easy,
    });
    db.createTask({
      id: 'c', projectRoot: dir, conversationId: second, prompt: 'three',
      status: 'done', complexity: 'easy', createdAt: 30, budget: BUDGETS.easy,
    });

    // Each chat sees its own tasks and nobody else's.
    assert.deepEqual(db.listConversationTasks(first).map((t) => t.id), ['b', 'a']);
    assert.deepEqual(db.listConversationTasks(second).map((t) => t.id), ['c']);

    // ...while the unscoped listing still sees everything. The live session
    // uses it to find the task it just started, so it must not be filtered.
    assert.equal(db.listTasks(dir).length, 3);

    // Most recently active first, not most recently created: 'second' was made
    // later but 'first' would win if a task had landed in it since.
    const chats = db.listConversations(dir);
    assert.deepEqual(chats.map((c) => c.title), ['fix the tests', 'add a parser']);
    assert.deepEqual(chats.map((c) => c.taskCount), [1, 2]);
    assert.equal(chats[1]!.lastActivityAt, 20);

    db.renameConversation(first, 'the parser work');
    assert.equal(db.listConversations(dir)[1]!.title, 'the parser work');

    // A task carries its chat back out of the row — this is what lets a
    // resumed task rejoin the conversation it started in.
    assert.equal(db.getTask('a')!.conversationId, first);
  } finally {
    db.close();
  }
});

test('store: step upsert keeps ordinal stable across updates', async () => {
  const { db, task } = await tempStore();
  try {
    const rec = (id: string, status: 'pending' | 'done') => ({
      taskId: task.id, stepId: id, spec: step({ id }),
      status, checkpointSha: null, attempts: 0,
    });
    db.upsertStep(rec('s1', 'pending'));
    db.upsertStep(rec('s2', 'pending'));
    db.upsertStep(rec('s1', 'done'));                     // update, not re-append
    const steps = db.getSteps(task.id);
    assert.deepEqual(steps.map((s) => s.stepId), ['s1', 's2']);
    assert.equal(steps[0]!.status, 'done');
  } finally {
    db.close();
  }
});

test('store: purgeFactsAfter invalidates that step\'s facts and later ones only', async () => {
  const { db, task } = await tempStore();
  try {
    for (const id of ['s1', 's2', 's3']) {
      db.upsertStep({ taskId: task.id, stepId: id, spec: step({ id }),
                      status: 'done', checkpointSha: null, attempts: 1 });
      db.addFacts(task.id, id, [`fact from ${id}`]);
    }
    assert.equal(db.getLiveFacts(task.id).length, 3);
    db.purgeFactsAfter(task.id, 's2');
    const live = db.getLiveFacts(task.id);
    assert.deepEqual(live.map((f) => f.stepId), ['s1']);
  } finally {
    db.close();
  }
});

test('store: events keep parentId, and totals sum tokens and cost', async () => {
  const { db, task } = await tempStore();
  try {
    const rootId = db.appendEvent({ taskId: task.id, kind: 'task_start', payload: {} });
    db.appendEvent({
      taskId: task.id, parentId: rootId, kind: 'llm_call', payload: { x: 1 },
      tokensIn: 10, tokensOut: 5, costUsd: 0.01, durationMs: 100,
    });
    const events = db.getEvents(task.id);
    assert.equal(events.length, 2);
    assert.equal(events[1]!.parentId, rootId);
    assert.deepEqual(events[1]!.payload, { x: 1 });

    const totals = db.totals(task.id);
    assert.equal(totals.tokens, 15);
    assert.ok(Math.abs(totals.costUsd - 0.01) < 1e-9);
    assert.equal(totals.durationMs, 100);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Failure classification without a model call
//
// The behaviour these lock down was measured on a real run: six diagnose
// calls cost 148 of 275 seconds, all failed validation, and the loop silently
// mislabelled every failure as transient_api.
// ---------------------------------------------------------------------------

test('classifyInCode: a detected loop is a wrong approach, no model needed', () => {
  assert.equal(classifyInCode({ looping: true }), 'wrong_approach');
  assert.equal(classifyInCode({ turnLimit: true }), 'wrong_approach');
});

test('classifyInCode: a call failure keeps the label callModel already assigned', () => {
  assert.equal(classifyInCode({ callKind: 'transient_api' }), 'transient_api');
  assert.equal(classifyInCode({ callKind: 'malformed_output' }), 'malformed_output');
});

test('classifyInCode: a red gate is a test failure', () => {
  assert.equal(classifyInCode({ verifyFailed: true }), 'test_failure');
});

test('classifyInCode: only the executor\'s own claim is ambiguous', () => {
  // No evidence we hold ourselves → null → and only then is a call spent.
  assert.equal(classifyInCode({}), null);
});

test('classifyInCode: code evidence outranks a bare model block', () => {
  // A step that both looped and failed verification is a loop first: the
  // loop is why the work never happened.
  assert.equal(classifyInCode({ looping: true, verifyFailed: true }), 'wrong_approach');
});

test('buildContext: the previous attempt is pinned and survives eviction', () => {
  const built = buildContext({
    role: 'execute',
    prompt: 'fix the thing',
    projectRules: null,
    previousAttempt: 'Attempt 1 FAILED (wrong_approach): called list_files 3 times.',
    // Enough filler to force eviction of everything droppable.
    facts: Array.from({ length: 400 }, (_, i) => ({
      id: i, taskId: 't', text: `fact number ${i} `.repeat(20),
      stepId: 's1', createdAt: 0, purgedAt: null,
    })),
  });
  const user = built.messages[1]!.content;
  assert.ok(built.compacted, 'should have had to drop something');
  assert.ok(user.includes('Attempt 1 FAILED'), 'retry feedback must never be evicted');
});

// ---------------------------------------------------------------------------
// Planning must never be able to kill a task, and servers must be startable
// ---------------------------------------------------------------------------

test('singleStepPlan: a failed plan degrades to one step carrying the request', () => {
  const task = {
    id: 't', projectRoot: '/tmp', conversationId: 'c1',
    prompt: 'make a calculator web app',
    status: 'running' as const, complexity: 'medium' as const,
    createdAt: 0, budget: BUDGETS.medium,
  };
  const plan = singleStepPlan(task);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]!.intent, 'make a calculator web app');
  assert.equal(plan.steps[0]!.difficulty, 'hairy');   // one step = the whole task
  assert.ok(plan.steps[0]!.acceptanceCriteria.length > 0);
});

test('findUrl: recovers the address a server announced', () => {
  assert.equal(findUrl('Server running at http://localhost:3000/'),
    'http://localhost:3000/');
  assert.equal(findUrl('Listening on 8080'), 'http://localhost:8080');
  assert.equal(findUrl('* Running on http://127.0.0.1:5000 (Press CTRL+C)'),
    'http://127.0.0.1:5000');
  assert.equal(findUrl('nothing useful here'), null);
});

test('toToolCall: start_server is a real tool, distinct from run_command', () => {
  assert.deepEqual(toToolCall({ action: 'start_server', command: 'node server.js' }),
    { name: 'start_server', args: { command: 'node server.js' } });
});

// ---------------------------------------------------------------------------
// Write-time verification: the agent's feedback loop closes at the write,
// not at the end of the step.
// ---------------------------------------------------------------------------

test('write_file reports a syntax error as its own result, and keeps the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'az-write-'));
  const ctx = { projectRoot: root, approval: async () => ({ approved: true }) };

  // A real error a model made: `delete` is a reserved word.
  const bad = await runTool(ctx, {
    name: 'write_file',
    args: { path: 'calc.js', content: 'function delete() { return 1; }\n' },
  });
  assert.equal(bad.ok, false, 'a file that does not parse is not a successful write');
  assert.match(bad.output, /does NOT parse/);
  assert.match(bad.output, /delete/);
  assert.deepEqual(bad.filesTouched, ['calc.js']);
  // The file must stay on disk: the model has to read it back to repair it.
  assert.equal(existsSync(join(root, 'calc.js')), true);

  const good = await runTool(ctx, {
    name: 'write_file',
    args: { path: 'calc.js', content: 'function remove() { return 1; }\n' },
  });
  assert.equal(good.ok, true);
  assert.match(good.output, /it parses/);
});

test('a fixable failure keeps the work instead of reverting it', () => {
  // Reverting a red check deletes the correct files along with the broken one
  // and leaves the retry unable to see what failed.
  assert.equal(TAXONOMY.test_failure, 'retry');
  // A flailing model's tree is not a foundation to build on.
  assert.equal(TAXONOMY.wrong_approach, 'revert');
});

// ---------------------------------------------------------------------------
// A task that changed nothing must say so, not send the user to an empty
// Review pane. (Observed: every step "done", status awaiting_review, summary
// "Review the diff to accept or reject the changes", and an empty diff.)
// ---------------------------------------------------------------------------

test('countChangedFiles: counts files in a diff, zero for an empty one', () => {
  assert.equal(countChangedFiles(''), 0);
  assert.equal(countChangedFiles('   \n'), 0);
  assert.equal(countChangedFiles([
    'diff --git a/a.py b/a.py',
    '--- a/a.py',
    '+++ b/a.py',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    'diff --git a/b.js b/b.js',
    '--- a/b.js',
    '+++ b/b.js',
    '@@ -1 +1 @@',
    '-1',
    '+2',
  ].join('\n')), 2);
});

// ---------------------------------------------------------------------------
// The agent's own account of its work
// ---------------------------------------------------------------------------

test('composeReport: one step speaks for itself, several become a list', () => {
  assert.equal(composeReport([]), undefined);
  assert.equal(composeReport([{ stepId: 's1', intent: 'i' }]), undefined);
  assert.equal(
    composeReport([{ stepId: 's1', intent: 'i', summary: 'Created calculator.js.' }]),
    'Created calculator.js.');
  assert.equal(
    composeReport([
      { stepId: 's1', intent: 'i', summary: 'Created calculator.js.' },
      { stepId: 's2', intent: 'i', summary: 'Started the server on 8080.' },
    ]),
    '• Created calculator.js.\n• Started the server on 8080.');
});

test('collectLinks: recovers the address the agent reported, deduplicated', () => {
  assert.deepEqual(
    collectLinks(['Server running on http://localhost:8080', 'nothing here']),
    ['http://localhost:8080']);
  assert.deepEqual(
    collectLinks(['see http://localhost:3000,', 'again http://localhost:3000']),
    ['http://localhost:3000']);
  assert.deepEqual(collectLinks(['no url at all']), []);
});

// ---------------------------------------------------------------------------
// Do no harm: a write may not turn a working file into a broken one.
// Observed live — a good 17-line file was destroyed by a malformed turn's
// repair, and every later turn was spent flailing against the corruption.
// ---------------------------------------------------------------------------

test('write_file rejects a regression and keeps the version that worked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'az-regress-'));
  const ctx = { projectRoot: root, approval: async () => ({ approved: true }) };
  const good = 'def perms(n):\n    return list(range(1, n + 1))\n';

  const first = await runTool(ctx, {
    name: 'write_file', args: { path: 'p.py', content: good },
  });
  assert.equal(first.ok, true);

  // The shape the repair loop actually produced: collapsed, unparseable.
  const clobber = await runTool(ctx, {
    name: 'write_file',
    args: { path: 'p.py', content: 'def perms(n): def perms(n): def perms(n):' },
  });
  assert.equal(clobber.ok, false);
  assert.match(clobber.output, /REJECTED/);
  assert.equal(await readFile(join(root, 'p.py'), 'utf8'), good,
    'the working version must survive a bad write');
  // Nothing was changed, so nothing should be reported as touched.
  assert.equal(clobber.filesTouched, undefined);
});

test('write_file still keeps a broken NEW file, since nothing good was lost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'az-newbad-'));
  const ctx = { projectRoot: root, approval: async () => ({ approved: true }) };
  const bad = await runTool(ctx, {
    name: 'write_file', args: { path: 'fresh.py', content: 'def (:\n' },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /does NOT parse/);
  assert.equal(existsSync(join(root, 'fresh.py')), true,
    'a broken first draft stays so the model can repair it');
});

// ---------------------------------------------------------------------------
// Approval feedback: a bare "no" leaves the model to guess, and it guesses
// the same thing again. The human's words must reach it verbatim.
// ---------------------------------------------------------------------------

test('a rejection carries the human\'s instruction to the model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'az-reject-'));
  const result = await runTool({
    projectRoot: root,
    approval: async () => ({ approved: false, feedback: 'put it in src/, not the root' }),
  }, { name: 'write_file', args: { path: 'x.py', content: 'x = 1\n' } });

  assert.equal(result.ok, false);
  assert.match(result.output, /put it in src\/, not the root/);
  assert.match(result.output, /Do not retry the rejected action as-is/);
  assert.equal(existsSync(join(root, 'x.py')), false, 'a rejected write must not happen');
});

test('a rejection with no instruction still says plainly that it was refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'az-reject2-'));
  const result = await runTool({
    projectRoot: root, approval: async () => ({ approved: false }),
  }, { name: 'write_file', args: { path: 'x.py', content: 'x = 1\n' } });
  assert.equal(result.ok, false);
  assert.match(result.output, /rejected this action/);
});

test('guidance given alongside an approval reaches the model too', async () => {
  const root = await mkdtemp(join(tmpdir(), 'az-approve-'));
  const result = await runTool({
    projectRoot: root,
    approval: async () => ({ approved: true, feedback: 'also handle n = 0' }),
  }, { name: 'write_file', args: { path: 'ok.py', content: 'def f(n):\n    return n\n' } });

  assert.equal(result.ok, true);
  assert.match(result.output, /it parses/);          // the tool still reports itself
  assert.match(result.output, /also handle n = 0/);  // and carries the note
  assert.equal(existsSync(join(root, 'ok.py')), true);
});

test('requestStop makes the agent signal fire, without killing anything', () => {
  // A stop is cooperative: the flag flips and the loop unwinds at a safe point.
  const cancel = new AbortController();
  const fake = { cancel, signal: cancel.signal } as unknown as Parameters<typeof requestStop>[0];
  assert.equal(fake.signal.aborted, false);
  requestStop(fake);
  assert.equal(fake.signal.aborted, true);
});

// ---------------------------------------------------------------------------
// Retry escalation — a recovery edge must not repeat an identical action
// ---------------------------------------------------------------------------

test('rank: difficulty alone cannot move a retry off a free model', () => {
  // Why retries escalate via `exclude` and not `difficulty: 'hairy'`.
  // `rank` sorts free-before-paid ABOVE strength, and among two free models
  // it already prefers the stronger one — so on a free-only setup 'hairy'
  // changes nothing and a "escalated" retry would re-run the same model.
  // If this ever starts failing, difficulty became a real lever and the
  // exclusion in runOneStep could lean on it instead.
  const router = new Router(new Set(['groq']));
  const base = { role: 'execute' as const, estimatedTokens: 1000 };
  const ids = (extra: object) =>
    router.rank({ ...base, ...extra }).map((c) => `${c.provider.id}/${c.model.id}`);

  assert.deepEqual(ids({}), ids({ difficulty: 'hairy' }));
});

test('rank: exclude moves the next attempt to a different model', () => {
  const router = new Router(new Set(['groq']));
  const base = { role: 'execute' as const, estimatedTokens: 1000 };
  const ids = (extra: object) =>
    router.rank({ ...base, ...extra }).map((c) => `${c.provider.id}/${c.model.id}`);

  const all = ids({});
  assert.ok(all.length > 1, 'need two candidates for this test to mean anything');

  // The spent model is gone, and the retry lands somewhere genuinely new.
  const afterOne = ids({ exclude: [all[0]!] });
  assert.ok(!afterOne.includes(all[0]!));
  assert.notEqual(afterOne[0], all[0]);

  // And when every model is spent, rank returns nothing rather than throwing.
  // callModel checks exactly this before honouring the caller's exclusions:
  // an empty ranking is the signal to drop them and reuse a spent model,
  // because a retry on the same model still beats a retry on nothing.
  assert.deepEqual(ids({ exclude: all }), []);
});

test('normalisePlan leaves orderSteps no cycle to degrade', () => {
  // orderSteps documents its cycle fallback as unreachable. This is why: a
  // dependency survives normalisation only when it points strictly backward,
  // and a strictly-backward graph cannot close a loop.
  const cyclic = {
    summary: 'mutually dependent steps',
    steps: [
      { id: 'a', intent: 'first', targetFiles: [], acceptanceCriteria: [],
        dependsOn: ['b'], difficulty: 'routine' as const },
      { id: 'b', intent: 'second', targetFiles: [], acceptanceCriteria: [],
        dependsOn: ['a'], difficulty: 'routine' as const },
    ],
  };

  const plan = normalisePlan(cyclic);
  const position = new Map(plan.steps.map((s, i) => [s.id, i]));
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      assert.ok(position.get(dep)! < position.get(step.id)!,
        `${step.id} depends on ${dep}, which is not strictly earlier`);
    }
  }

  // Every step still comes out, in an order that respects what survived.
  assert.deepEqual(orderSteps(plan.steps).map((s) => s.id), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// Cross-platform behaviour. Only the branch for the machine running the suite
// can actually execute here; the assertions are written so the OTHER branch is
// visible in the source rather than assumed.
// ---------------------------------------------------------------------------

test('toPosix: one spelling of a path, whatever the OS produced', () => {
  // join() gives the native spelling; the assertion is the spelling the model
  // and git must both see. On POSIX these are already the same string — which
  // is the point of the helper, not a reason to skip it.
  assert.equal(toPosix(join('src', 'agent', 'tools.ts')), 'src/agent/tools.ts');
  assert.equal(toPosix(''), '');

  // And what it must NOT do off Windows: a backslash is an ordinary character
  // in a POSIX filename, so rewriting it would invent a directory. (This is a
  // change from the scanner's old unconditional split, which turned a file
  // called `a\b.ts` into a phantom `a/b.ts`.)
  if (process.platform !== 'win32') {
    assert.equal(toPosix('a\\b.ts'), 'a\\b.ts');
  }
});

test('shellInvocation: a login shell, the command passed through untouched', async () => {
  const sh = await shellInvocation('pytest -q && echo done');
  assert.deepEqual(sh.args, ['-lc', 'pytest -q && echo done']);
  assert.ok(sh.file.length > 0, 'a shell was resolved for this platform');

  // CHERE_INVOKING is what stops a Windows login shell cd-ing to $HOME and
  // running every command outside the project. Nothing to correct on POSIX.
  assert.equal('CHERE_INVOKING' in sh.env, process.platform === 'win32');
});

test('checkFileSyntax: python is found under whichever name it has here', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agentzero-py-'));
  await writeFile(join(dir, 'broken.py'), 'def f(:\n');
  await writeFile(join(dir, 'fine.py'), 'def f():\n    return 1\n');

  const broken = await checkFileSyntax(dir, 'broken.py');
  if (broken === null) {
    // No python3 AND no python on this machine. That is the other half of the
    // contract, and the more important half: an absent interpreter leaves the
    // file unchecked rather than condemning a file that is perfectly fine.
    t.skip('no python interpreter on this machine');
    return;
  }
  assert.match(broken, /does not parse/);
  assert.equal(await checkFileSyntax(dir, 'fine.py'), null);
});

// ---------------------------------------------------------------------------
// REPLAN's merge strategy — doneSteps first, revised steps after
// ---------------------------------------------------------------------------

test('normalisePlan: REPLAN merge keeps done steps, backward deps, renames a collision', () => {
  // Mirrors exactly what `replan()` in orchestrator.ts builds: already-done
  // steps from the OLD plan placed first, a freshly-planned tail after. This
  // pins the property the whole REPLAN design leans on — that feeding that
  // shape through the existing normalisePlan is enough to make it safe to
  // execute, with no bespoke merge logic needed.
  const doneSteps = [
    { id: 's1', intent: 'create the file', targetFiles: ['a.py'],
      acceptanceCriteria: [], dependsOn: [], difficulty: 'routine' as const },
    { id: 's2', intent: 'add the import', targetFiles: ['a.py'],
      acceptanceCriteria: [], dependsOn: ['s1'], difficulty: 'routine' as const },
  ];
  // A revised tail from a fresh planning call: the model has no idea what
  // ids are already taken, so it starts again from "s1" — a real collision.
  const revisedSteps = [
    { id: 's1', intent: 'wire the new approach into a.py', targetFiles: ['a.py'],
      acceptanceCriteria: [], dependsOn: ['s2'], difficulty: 'routine' as const },
  ];

  const merged = normalisePlan({
    summary: 'original summary', steps: [...doneSteps, ...revisedSteps],
  });

  // Both done steps survive under their ORIGINAL ids — a resume or a second
  // replan still recognises them as the same steps.
  assert.equal(merged.steps[0]!.id, 's1');
  assert.equal(merged.steps[0]!.intent, 'create the file');
  assert.equal(merged.steps[1]!.id, 's2');
  assert.equal(merged.steps[1]!.dependsOn.includes('s1'), true);

  // The colliding new step was renamed, not dropped or overwritten.
  assert.equal(merged.steps.length, 3);
  const revised = merged.steps[2]!;
  assert.notEqual(revised.id, 's1');
  assert.equal(revised.intent, 'wire the new approach into a.py');
  // Its dependency on 's2' — a real, earlier, done step — survives.
  assert.equal(revised.dependsOn.includes('s2'), true);
});

// ---------------------------------------------------------------------------
// blastRadius — HITL's "re-run blast radius" guard (doc §15)
// ---------------------------------------------------------------------------

test('blastRadius: follows dependsOn forward through a diamond, skips the unrelated', () => {
  const step = (id: string, dependsOn: string[]) => ({
    taskId: 't', stepId: id, status: 'done' as const, checkpointSha: null, attempts: 1,
    spec: {
      id, intent: id, targetFiles: [], acceptanceCriteria: [], dependsOn,
      difficulty: 'routine' as const,
    },
  });
  // s1 -> s2 -> s4
  //   \-> s3 -/         s5 stands alone.
  const steps = [
    step('s1', []), step('s2', ['s1']), step('s3', ['s1']),
    step('s4', ['s2', 's3']), step('s5', []),
  ];

  const radius = blastRadius(steps, ['s1']);
  assert.deepEqual([...radius].sort(), ['s1', 's2', 's3', 's4']);
  assert.equal(radius.has('s5'), false);
});

test('blastRadius: a leaf step with no dependents radiates only itself', () => {
  const step = (id: string, dependsOn: string[]) => ({
    taskId: 't', stepId: id, status: 'done' as const, checkpointSha: null, attempts: 1,
    spec: {
      id, intent: id, targetFiles: [], acceptanceCriteria: [], dependsOn,
      difficulty: 'routine' as const,
    },
  });
  const steps = [step('s1', []), step('s2', ['s1'])];

  assert.deepEqual([...blastRadius(steps, ['s2'])], ['s2']);
});
