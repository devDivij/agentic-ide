/**
 * Offline test suite for the agent runtime's pure logic. No network, no model
 * calls, no API keys — `npm test` must pass on a clean machine.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { coerceTurn, extractJson } from '../src/agent/parse.ts';
import { normalisePlan, singleStepPlan } from '../src/agent/workers.ts';
import {
  classifyInCode, collectLinks, composeReport, countChangedFiles, orderSteps,
  parsePinTags, TAXONOMY, toToolCall,
} from '../src/agent/orchestrator.ts';
import {
  BUDGETS, RateBucket, Router, isPayingWorthIt, scoreTask, SECONDS_PER_USD,
} from '../src/agent/router.ts';
import { buildContext } from '../src/agent/context.ts';
import { buildPatch, parseDiff } from '../src/web/review.ts';
import { confinePath, PathEscapeError } from '../src/agent/paths.ts';
import { findUrl, runTool, scrubEnvironment } from '../src/agent/tools.ts';
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
// store.ts — the SQLite substrate
// ---------------------------------------------------------------------------

async function tempStore(): Promise<{ db: Store; task: Task }> {
  const dir = await mkdtemp(join(tmpdir(), 'az-store-'));
  const db = new Store(dir);
  const task: Task = {
    id: 'task-1', projectRoot: dir, prompt: 'do the thing',
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
    id: 't', projectRoot: '/tmp', prompt: 'make a calculator web app',
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
  const ctx = { projectRoot: root, approval: async () => true };

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
