/**
 * callModel(): the single path every model call takes.
 *
 * Route → log the decision → dispatch → log the exact exchange → validate
 * against the schema → repair or fall back. Centralising this once gives two
 * properties by construction:
 *   - every call is logged identically, so the trace is complete without
 *     remembering to instrument each call site;
 *   - fallback is uniform: a rate-limited provider is swapped out underneath
 *     any role without that role knowing.
 *
 * Repair and fallback are deliberately distinct remedies:
 *   - a MALFORMED reply → ask the SAME model again with the parse error
 *     attached (a repair turn quotes "that response", so it must go back to
 *     the model that produced it);
 *   - a 429/5xx/timeout → the model never answered, so switch provider
 *     without spending a repair attempt;
 *   - TRUNCATED REASONING → the model ran out of output budget while
 *     thinking; give it more room, not a repair prompt.
 * Conflating these wastes retries on the wrong remedy.
 */

import { z } from 'zod';

import type { Role } from './types.ts';
import type { Store } from './store.ts';
import type { RouteDecision, Router } from './router.ts';
import type { BuiltContext } from './context.ts';
import { chatComplete, TransientProviderError, TruncatedReasoningError } from './llm.ts';
import { describeZodError, extractJson } from './parse.ts';

/** What callModel needs from the agent context (orchestrator.ts provides it). */
export interface CallDeps {
  db: Store;
  router: Router;
  keys: Map<string, string>;
}

export interface CallOptions<T> {
  taskId: string;
  role: Role;
  context: BuiltContext;
  schema: z.ZodType<T, z.ZodTypeDef, any>;
  /** Normalise model-emitted shapes before validation (see parse.coerceTurn). */
  coerce?: (raw: unknown) => unknown;
  /** Trace parent, so this call nests under the right node. */
  parentId?: number | null;
  stepId?: string | null;
  maxTokens?: number;
  temperature?: number;
  difficulty?: 'routine' | 'hairy';
  /** Skip chain-of-thought (mechanical roles: ~20x cheaper, same answer). */
  suppressReasoning?: boolean;
}

const MAX_REPAIRS = 2;
const MAX_FALLBACKS = 3;

export class CallFailedError extends Error {
  constructor(message: string, readonly kind: 'malformed_output' | 'transient_api') {
    super(message);
    this.name = 'CallFailedError';
  }
}

export async function callModel<T>(
  deps: CallDeps, opts: CallOptions<T>,
): Promise<{ value: T; eventId: number }> {
  const { db, router, keys } = deps;
  const { taskId, context } = opts;

  // Record exactly what went into this window, before sending it.
  db.appendEvent({
    taskId, parentId: opts.parentId ?? null, kind: 'assemble',
    role: opts.role, stepId: opts.stepId ?? null,
    payload: {
      manifest: context.manifest,
      estimatedTokens: context.estimatedTokens,
      compacted: context.compacted,
    },
  });
  if (context.compacted) {
    // Compaction is an observable event, never an invisible truncation.
    db.appendEvent({
      taskId, parentId: opts.parentId ?? null, kind: 'compact',
      role: opts.role, stepId: opts.stepId ?? null,
      payload: { reason: 'assembled window exceeded budget', dropped: context.droppedKinds },
    });
  }

  const excluded: string[] = [];
  let messages = context.messages;
  let repairs = 0;
  let fallbacks = 0;
  let budgetBumps = 0;
  let maxTokens = opts.maxTokens ?? 2048;
  let lastError = 'unknown';
  // Pinned once a model has answered: a repair turn must go back to the model
  // whose reply it is repairing.
  let stickyRoute: { providerId: string; modelId: string } | null = null;

  for (;;) {
    const route: RouteDecision = stickyRoute
      ? { ...stickyRoute, reason: 'continuing repair on the same model',
          runnersUp: [], estimatedCostUsd: 0, waitedMs: 0 }
      : await router.pick({
          role: opts.role,
          estimatedTokens: context.estimatedTokens,
          ...(opts.difficulty ? { difficulty: opts.difficulty } : {}),
          exclude: excluded,
        });

    // The routing decision is an event BEFORE the call is made — never hidden.
    db.appendEvent({
      taskId, parentId: opts.parentId ?? null, kind: 'route',
      role: opts.role, stepId: opts.stepId ?? null,
      payload: route, model: route.modelId, provider: route.providerId,
    });

    try {
      const result = await chatComplete(route.providerId, route.modelId, {
        messages,
        maxTokens,
        temperature: opts.temperature ?? 0.2,
        json: true,
        ...(opts.suppressReasoning ? { suppressReasoning: true } : {}),
      }, keys);

      router.recordUsage(route.providerId, result.tokensIn + result.tokensOut);

      const eventId = db.appendEvent({
        taskId, parentId: opts.parentId ?? null, kind: 'llm_call',
        role: opts.role, stepId: opts.stepId ?? null,
        // Exact input and output, never truncated at write time. `reasoning`
        // is the model's own thought process, shown in the dashboard.
        payload: {
          messages,
          completion: result.text,
          ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        },
        model: result.model, provider: result.provider,
        tokensIn: result.tokensIn, tokensOut: result.tokensOut,
        costUsd: result.costUsd, durationMs: result.durationMs,
      });

      const raw = extractJsonSafe(result.text);
      const parsed = opts.schema.safeParse(opts.coerce ? opts.coerce(raw) : raw);
      if (parsed.success) return { value: parsed.data, eventId };

      // Malformed → repair on the same model, with the specific error attached.
      lastError = describeZodError(parsed.error);
      if (repairs >= MAX_REPAIRS) {
        throw new CallFailedError(
          `Model output failed validation after ${repairs} repair attempts:\n${lastError}`,
          'malformed_output');
      }
      repairs++;
      stickyRoute = { providerId: route.providerId, modelId: route.modelId };
      messages = [
        ...context.messages,
        { role: 'assistant', content: result.text },
        { role: 'user', content:
            `That response was not valid for the required schema:\n${lastError}\n\n` +
            `Reply with ONLY a single JSON object that satisfies the schema. ` +
            `No prose, no code fences.` },
      ];

    } catch (err) {
      if (err instanceof CallFailedError) throw err;

      if (err instanceof TruncatedReasoningError) {
        // We underfunded the model, it did not misbehave. Buy it room.
        db.appendEvent({
          taskId, parentId: opts.parentId ?? null, kind: 'error',
          role: opts.role, stepId: opts.stepId ?? null,
          payload: { failureClass: 'truncated_reasoning', tokensSpentThinking: err.tokensOut,
                     action: 'retrying with a larger output budget' },
          status: 'error',
        });
        if (++budgetBumps > 2) {
          throw new CallFailedError(
            'Model kept exhausting its output budget while reasoning.', 'malformed_output');
        }
        maxTokens = Math.max(maxTokens * 3, 4096);
        continue;
      }

      const transient = err instanceof TransientProviderError;
      if (transient) router.penalize(err.providerId, err.retryAfterMs);

      db.appendEvent({
        taskId, parentId: opts.parentId ?? null, kind: 'error',
        role: opts.role, stepId: opts.stepId ?? null,
        payload: {
          failureClass: transient ? 'transient_api' : 'provider_error',
          provider: route.providerId,
          message: (err as Error).message,
          action: 'switching provider; task state untouched',
        },
        status: 'error',
      });

      // Either way the model never answered usefully — try elsewhere without
      // spending a repair attempt.
      lastError = (err as Error).message;
      stickyRoute = null;
      excluded.push(`${route.providerId}/${route.modelId}`);
      if (++fallbacks > MAX_FALLBACKS) {
        throw new CallFailedError(
          `All providers failed for role '${opts.role}': ${lastError}`, 'transient_api');
      }
    }
  }
}

/** Never let a malformed reply throw before it can become a repair turn. */
function extractJsonSafe(text: string): unknown {
  try { return extractJson(text); } catch { return { __unparseable: text.slice(0, 500) }; }
}
