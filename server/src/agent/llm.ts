/**
 * The HTTP call to a model. One function for every provider, because every
 * provider we support speaks the same OpenAI chat-completions shape (Ollama
 * included). Everything above this — routing, retries, validation — lives in
 * call.ts; this file only knows how to send one request and read one reply.
 */

import { estimateCostUsd, getModel, getProvider } from './providers.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Ask for JSON. Advisory — several providers ignore it, so we validate anyway. */
  json?: boolean;
  /** Turn off chain-of-thought on models that think by default (see providers.ts). */
  suppressReasoning?: boolean;
  /** Override the hang timeout. Mechanical roles pass something much shorter. */
  timeoutMs?: number;
}

export interface ChatResult {
  text: string;
  /** The model's separate chain-of-thought, when reported. Logged as its "thought process". */
  reasoning?: string;
  /**
   * Why the model stopped. 'length' means it was cut off mid-sentence, which
   * the caller must not mistake for a malformed answer: the remedy is a
   * bigger budget, not a repair prompt.
   */
  finishReason?: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  model: string;
  provider: string;
}

/**
 * The model does not exist any more (404/410).
 *
 * Distinct from a transient failure because the remedy is different and
 * permanent: retire it for the session instead of retrying it. Free line-ups
 * rotate constantly — NVIDIA's 49B and 70B entries began 404-ing, its 9B
 * entry later returned 410 Gone, and two Groq models 404-ed the same week.
 * Without this, every task rediscovers each corpse and spends a fallback on it.
 */
export class ModelGoneError extends Error {
  constructor(readonly providerId: string, readonly modelId: string,
              readonly statusCode: number) {
    super(`${providerId}/${modelId} no longer exists (HTTP ${statusCode}). ` +
          `Run 'npm run cli -- providers' to see what still answers.`);
    this.name = 'ModelGoneError';
  }
}

/** 429/5xx/timeout: the model never answered. Remedy: another provider. */
export class TransientProviderError extends Error {
  constructor(message: string, readonly providerId: string,
              readonly retryAfterMs: number, readonly statusCode: number) {
    super(message);
    this.name = 'TransientProviderError';
  }
}

/**
 * A reasoning model spent its whole output budget thinking and never answered.
 * Remedy: a bigger budget — not a repair prompt, and not another provider.
 */
export class TruncatedReasoningError extends Error {
  constructor(readonly reasoning: string, readonly tokensOut: number) {
    super(`Model exhausted its ${tokensOut}-token output budget while reasoning.`);
    this.name = 'TruncatedReasoningError';
  }
}

/**
 * How long to wait before calling a request hung rather than slow.
 *
 * This was 120s, and a provider that simply never answered cost 120 of one
 * run's 146 seconds — 82% of it spent waiting on a call that was never
 * coming. Measured legitimate calls on these models: classify ~2s, diagnose
 * ~10s, plan 13-50s, execute 3-19s. So a generation call gets real headroom
 * and a mechanical one does not, because a 30s classify is not slow, it is
 * broken — and the sooner we know, the sooner the router tries elsewhere.
 */
const DEFAULT_TIMEOUT_MS = 75_000;

export async function chatComplete(
  providerId: string, modelId: string, req: ChatRequest, keys: Map<string, string>,
): Promise<ChatResult> {
  const provider = getProvider(providerId);
  const model = getModel(providerId, modelId);
  if (!provider || !model) throw new Error(`Unknown model '${providerId}/${modelId}'`);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.keyEnv) {
    const key = keys.get(providerId);
    if (!key) throw new Error(`No API key configured for ${provider.label}`);
    headers.Authorization = `Bearer ${key}`;
  }

  // A model that thinks by default needs room to think AND answer; asking for
  // the usual budget guarantees an empty response.
  const willReason = model.reasoning?.byDefault === true && !req.suppressReasoning;
  const maxTokens = willReason
    ? Math.max(req.maxTokens ?? 2048, model.reasoning?.minOutputTokens ?? 1500)
    : req.maxTokens ?? 2048;

  // Suppressing via a system directive ('/no_think') measured ~20x cheaper
  // than letting the model think on mechanical roles.
  const messages = req.suppressReasoning && model.reasoning?.disableDirective
    ? [{ role: 'system' as const, content: model.reasoning.disableDirective }, ...req.messages]
    : req.messages;

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    temperature: req.temperature ?? 0.2,
    max_tokens: maxTokens,
    stream: false,
  };
  if (req.json) body.response_format = { type: 'json_object' };

  const startedAt = Date.now();
  const res = await fetchWithTimeout(
    `${provider.baseUrl}/chat/completions`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    providerId,
    req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 429 || res.status >= 500) {
      throw new TransientProviderError(
        `${provider.label} returned ${res.status}: ${text.slice(0, 200)}`,
        providerId, parseRetryAfter(res.headers.get('retry-after')), res.status);
    }
    if (res.status === 404 || res.status === 410) {
      throw new ModelGoneError(providerId, modelId, res.status);
    }
    throw new Error(`${provider.label} returned ${res.status}: ${text.slice(0, 400)}`);
  }

  const json = await res.json() as any;
  const choice = json?.choices?.[0];
  const message = choice?.message ?? {};

  const reasoning: string = message.reasoning_content ?? message.reasoning ?? '';
  const raw: string = message.content ?? '';

  if (!raw.trim() && choice?.finish_reason === 'length') {
    throw new TruncatedReasoningError(reasoning, json?.usage?.completion_tokens ?? 0);
  }

  // Some models inline their thinking as <think> tags instead of a separate field.
  const text = stripThinkBlocks(raw);

  // Providers are inconsistent about usage reporting; estimate rather than
  // silently record zero cost.
  const tokensIn: number = json?.usage?.prompt_tokens
    ?? estimateTokens(messages.map((m) => m.content).join('\n'));
  const tokensOut: number = json?.usage?.completion_tokens ?? estimateTokens(text);

  return {
    text,
    ...(reasoning ? { reasoning } : {}),
    ...(choice?.finish_reason ? { finishReason: String(choice.finish_reason) } : {}),
    tokensIn,
    tokensOut,
    costUsd: estimateCostUsd(model, tokensIn, tokensOut),
    durationMs: Date.now() - startedAt,
    model: modelId,
    provider: providerId,
  };
}

async function fetchWithTimeout(
  url: string, init: RequestInit, providerId: string, timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // A timeout or socket error is transient: another provider may well work.
    // Penalise this one for longer than a plain error — a model that hung once
    // tends to hang again, and re-picking it costs the whole timeout.
    const hung = controller.signal.aborted;
    throw new TransientProviderError(
      hung
        ? `${providerId} did not respond within ${(timeoutMs / 1000).toFixed(0)}s`
        : `Request to ${providerId} failed: ${(err as Error).message}`,
      providerId, hung ? 30_000 : 2_000, 0);
  } finally {
    clearTimeout(timer);
  }
}

export function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

function parseRetryAfter(header: string | null): number {
  if (!header) return 5_000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 5_000;
}

/**
 * Rough token count (~4 chars/token). Deliberately not a real tokenizer: this
 * feeds pre-call budget decisions where 10% error changes nothing, and every
 * provider reports exact usage afterwards.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
