/**
 * Context assembly: build the window for ONE model call, fresh, from durable
 * state — the plan, the step, live facts, retrieved code, user pins.
 *
 * There is no rolling conversation transcript anywhere in this system. That
 * single decision buys two requirements for free:
 *   - fallback without losing progress: a dead call loses only itself,
 *     because nothing lived inside the conversation;
 *   - nothing is ever paraphrased across "compactions", so earlier
 *     information cannot be misremembered — it is re-read from the store.
 *
 * Compaction: the durable state usually fits, but the fact ledger and
 * retrieved chunks grow on long tasks. When the assembled window would exceed
 * budget we drop blocks in strict priority order (cross-step outcomes first,
 * then retrieved chunks, then oldest facts) and report what was dropped, so
 * the caller can record a visible `compact` event. Never dropped: the user's
 * request, project rules, the plan, the current step, user pins, the step's
 * own transcript, and the output contract.
 */

import type { ChatMessage } from './llm.ts';
import type { CodeChunk, Fact, Plan, PlanStep, Role } from './types.ts';
import { estimateTokens } from './llm.ts';

export interface ContextRequest {
  role: Role;
  /** The user's original request. */
  prompt: string;
  /** AGENTS.md, injected on every call — a preference survives compaction by construction. */
  projectRules: string | null;
  /** Real paths in the project, so the model cannot invent one. */
  projectFiles?: string[];
  plan?: Plan;
  step?: PlanStep;
  /** Files/ranges the user pinned by hand. Never evicted. */
  pinned?: CodeChunk[];
  facts?: Fact[];
  chunks?: CodeChunk[];
  /** Outcome lines from earlier steps. First thing dropped under pressure. */
  recentOutcomes?: string[];
  /**
   * What the executor already did within the CURRENT step. Passed as state,
   * not conversation — which is what makes switching models mid-step safe.
   * Never evicted: dropping it makes the model repeat its own edits.
   */
  stepTranscript?: string[];
  /** Exact JSON shape this call must return. Rendered LAST — small models
   *  follow the most recent instruction most reliably. */
  outputContract?: string;
}

export interface BuiltContext {
  messages: ChatMessage[];
  estimatedTokens: number;
  /** Exactly what went in — recorded as an `assemble` event for the trace. */
  manifest: Array<{ kind: string; ref: string; tokens: number }>;
  /** True when something had to be dropped to fit. */
  compacted: boolean;
  droppedKinds: string[];
}

type Priority = 'pinned' | 'fact' | 'chunk' | 'outcome';

interface Block {
  kind: string;
  ref: string;
  text: string;
  priority: Priority;
  tokens: number;
}

/** Higher number = dropped sooner. 'pinned' is never dropped. */
const EVICTION_ORDER: Record<Priority, number> = { pinned: 0, fact: 1, chunk: 2, outcome: 3 };

/** Fraction of the assumed window we fill; the rest is answer room + estimate error. */
const WINDOW_FRACTION = 0.6;

export function buildContext(req: ContextRequest): BuiltContext {
  const blocks: Block[] = [];
  const add = (kind: string, ref: string, text: string, priority: Priority): void => {
    if (!text.trim()) return;
    blocks.push({ kind, ref, text, priority, tokens: estimateTokens(text) });
  };

  // --- never evicted -------------------------------------------------------
  add('request', 'prompt', `<request>\n${req.prompt}\n</request>`, 'pinned');

  if (req.projectRules) {
    add('rules', 'AGENTS.md',
      `Project rules (must be followed):\n${req.projectRules}`, 'pinned');
  }

  if (req.projectFiles && req.projectFiles.length > 0) {
    const shown = req.projectFiles.slice(0, 120);
    add('files', 'project-files',
      `Files in this project (use these exact paths, never invent one):\n` +
      shown.map((f) => `  ${f}`).join('\n') +
      (req.projectFiles.length > shown.length
        ? `\n  ... and ${req.projectFiles.length - shown.length} more` : ''),
      'pinned');
  }

  if (req.plan) {
    add('plan', 'plan',
      `Overall plan: ${req.plan.summary}\n` +
      req.plan.steps.map((s) => `  ${s.id}. ${s.intent}`).join('\n'),
      'pinned');
  }

  if (req.step) {
    add('step', req.step.id,
      `Your current step (${req.step.id}): ${req.step.intent}\n` +
      `Target files: ${req.step.targetFiles.join(', ') || '(decide yourself)'}\n` +
      `Done when:\n${req.step.acceptanceCriteria.map((c) => `  - ${c}`).join('\n')}`,
      'pinned');
  }

  for (const pin of req.pinned ?? []) {
    add('pin', `${pin.path}:${pin.startLine}-${pin.endLine}`,
      `--- ${pin.path} lines ${pin.startLine}-${pin.endLine} (pinned by the user) ---\n${pin.text}`,
      'pinned');
  }

  // --- evictable -----------------------------------------------------------
  for (const fact of req.facts ?? []) {
    add('fact', `#${fact.id}`, `- ${fact.text}`, 'fact');
  }
  for (const chunk of req.chunks ?? []) {
    add('chunk', `${chunk.path}:${chunk.startLine}`,
      `--- ${chunk.path} lines ${chunk.startLine}-${chunk.endLine} (${chunk.reason}) ---\n${chunk.text}`,
      'chunk');
  }
  if ((req.recentOutcomes ?? []).length > 0) {
    add('outcomes', 'recent',
      `Recent steps:\n${req.recentOutcomes!.map((o) => `  - ${o}`).join('\n')}`,
      'outcome');
  }

  // --- pinned tail ---------------------------------------------------------
  if ((req.stepTranscript ?? []).length > 0) {
    add('transcript', 'this-step',
      `What you have ALREADY done in this step:\n` +
      req.stepTranscript!.map((t, i) => `  ${i + 1}. ${t}`).join('\n') +
      `\n\nDo not repeat any of the above. If the required change is now in place, ` +
      `reply with action "done" and list the files you changed.`,
      'pinned');
  }
  if (req.outputContract) {
    add('contract', 'output-format', req.outputContract, 'pinned');
  }

  // --- fit to budget -------------------------------------------------------
  const budget = budgetTokens(req.role);
  const { kept, dropped } = evictToFit(blocks, budget);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPreamble(req.role) },
    { role: 'user', content: kept.map((b) => b.text).join('\n\n') },
  ];

  return {
    messages,
    estimatedTokens: estimateTokens(messages.map((m) => m.content).join('\n')),
    manifest: kept.map((b) => ({ kind: b.kind, ref: b.ref, tokens: b.tokens })),
    compacted: dropped.length > 0,
    droppedKinds: [...new Set(dropped.map((b) => b.kind))],
  };
}

/**
 * Token ceiling for one call. Conservative (the router may pick any model
 * serving this role, and the smallest window defines what must fit).
 */
function budgetTokens(role: Role): number {
  const window = role === 'execute' ? 32_000 : 16_000;
  return Math.floor(window * WINDOW_FRACTION);
}

/**
 * Drop the least valuable blocks until the total fits. Pinned blocks are
 * exempt: if they alone exceed the budget we send them anyway — silently
 * discarding the plan or the user's pins would be worse than a big prompt.
 */
function evictToFit(blocks: Block[], budget: number): { kept: Block[]; dropped: Block[] } {
  let total = blocks.reduce((n, b) => n + b.tokens, 0);
  if (total <= budget) return { kept: blocks, dropped: [] };

  const dropped: Block[] = [];
  const removable = blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.priority !== 'pinned')
    // Most droppable first; within a priority, later (older-listed) first.
    .sort((x, y) => EVICTION_ORDER[y.b.priority] - EVICTION_ORDER[x.b.priority] || y.i - x.i);

  const removed = new Set<number>();
  for (const { b, i } of removable) {
    if (total <= budget) break;
    removed.add(i);
    dropped.push(b);
    total -= b.tokens;
  }
  return { kept: blocks.filter((_, i) => !removed.has(i)), dropped };
}

/** Short role framing — weak models follow short instructions better. */
function systemPreamble(role: Role): string {
  const base = 'You are a precise coding agent working inside a real repository. ' +
    'Be concise. Never invent file contents you have not been shown.';
  switch (role) {
    case 'plan':     return `${base} You break work into small, independently checkable steps.`;
    case 'execute':  return `${base} You make one focused change at a time using the tools provided.`;
    case 'diagnose': return `${base} You classify why something failed. You never propose a fix.`;
    case 'classify': return `${base} You estimate task difficulty.`;
    case 'ask':      return 'You are a concise, accurate programming assistant. ' +
                            'Answer the question directly.';
  }
}
