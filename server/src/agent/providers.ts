/**
 * The provider and model catalogue — data, not code.
 *
 * Every provider we support speaks the OpenAI chat-completions API, so adding
 * a provider is adding a row here, never writing an adapter. Rate limits are
 * recorded per provider because they are the dominant routing signal: each
 * free tier is starved in a different dimension (Groq by tokens/day, Mistral
 * by requests/minute), so holding several at once usually leaves one able to
 * serve right now. router.ts turns these numbers into decisions.
 *
 * The competition caps every model at 80B TOTAL parameters. That is enforced
 * by assertLegalCatalogue() at startup — a non-compliant build refuses to run
 * — and every entry cites the source of its parameter count so the number can
 * be defended, not just asserted.
 */

import type { Role } from './types.ts';

/** Hard ceiling from the problem statement (total params, not active). */
export const MAX_TOTAL_PARAMS_B = 80;

export interface ModelSpec {
  /** Model id sent on the wire, exactly as the provider expects it. */
  id: string;
  /** Total parameters in billions, with the citation beside it. */
  totalParamsB: number;
  paramsSource: string;
  contextTokens: number;
  costPerMTokIn: number;   // dollars per million input tokens (0 = free tier)
  costPerMTokOut: number;
  /** Roles this model is a sensible choice for. */
  roles: Role[];
  /**
   * Chain-of-thought behaviour. A reasoning model spends its output budget
   * thinking before answering; if the budget runs out mid-thought the call
   * returns HTTP 200 with an EMPTY answer. Measured on nemotron-nano-9b:
   * a trivial JSON reply costs 121 tokens with reasoning on, 6 with it off.
   * So llm.ts raises the budget for these models, and suppresses thinking
   * entirely on mechanical roles via `disableDirective`.
   */
  reasoning?: {
    byDefault: boolean;
    disableDirective?: string;   // e.g. '/no_think' as a system message
    minOutputTokens?: number;    // room to think AND answer
  };
}

export interface RateLimits {
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  requestsPerDay?: number;
  tokensPerDay?: number;
}

/**
 * How eagerly the router reaches for a provider:
 *   'user'    — the operator configured a key for it; an explicit choice wins.
 *   'default' — zero-config fallback (NVIDIA NIM); used only when no 'user'
 *               provider can serve the role, so the system works out of the box
 *               but steps aside the moment you configure something better.
 *   'floor'   — local Ollama; needs no key, always last (slow, and wall-clock
 *               is 35% of the score).
 */
export type Preference = 'user' | 'default' | 'floor';

export interface ProviderSpec {
  id: string;
  label: string;
  baseUrl: string;
  /** Env var / settings field holding the key; null = no key needed. */
  keyEnv: string | null;
  /** Disabled rows stay in the catalogue as ready-to-enable options. */
  enabled: boolean;
  preference: Preference;
  limits: RateLimits;
  models: ModelSpec[];
  notes?: string;
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export const PROVIDERS: ProviderSpec[] = [
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyEnv: 'NVIDIA_API_KEY',
    enabled: true,
    preference: 'default',
    limits: { requestsPerMinute: 40 },
    // NIM's /models list advertises models that 404 on invocation, so every
    // entry below was verified with a real chat completion (2026-08-26).
    // Notably dead despite being listed: llama-3.3-nemotron-super-49b (v1 and
    // v1.5) and meta/llama-3.3-70b-instruct. `npm run cli -- providers` is
    // how to re-check; free lineups rotate without notice.
    notes: 'Zero-config default. Every model verified invocable, not just listed.',
    models: [
      {
        id: 'nvidia/nemotron-3.5-lightning-30b-a3b',
        totalParamsB: 30,
        paramsSource: 'NVIDIA model card: Nemotron 3.5 Lightning 30B-A3B (30B total / 3B active)',
        contextTokens: 128_000,
        costPerMTokIn: 0, costPerMTokOut: 0,
        roles: ['plan', 'execute', 'diagnose', 'ask'],
        // Measured: 594 chars of reasoning_content for a trivial JSON reply.
        reasoning: { byDefault: true, disableDirective: '/no_think', minOutputTokens: 2000 },
      },
      {
        id: 'nvidia/nemotron-3-nano-30b-a3b',
        totalParamsB: 30,
        paramsSource: 'NVIDIA model card: Nemotron-3-Nano-30B-A3B (30B total / 3B active)',
        contextTokens: 128_000,
        costPerMTokIn: 0, costPerMTokOut: 0,
        roles: ['plan', 'execute', 'classify'],
        reasoning: { byDefault: true, disableDirective: '/no_think', minOutputTokens: 2000 },
      },
      {
        // Note the doubled prefix — 'nvidia/nemotron-nano-9b-v2' 404s.
        id: 'nvidia/nvidia-nemotron-nano-9b-v2',
        totalParamsB: 9,
        paramsSource: 'NVIDIA model card: Nemotron-Nano-9B-v2',
        contextTokens: 128_000,
        costPerMTokIn: 0, costPerMTokOut: 0,
        roles: ['classify', 'ask'],
        reasoning: { byDefault: true, disableDirective: '/no_think', minOutputTokens: 1500 },
      },
      {
        // Different vendor on the same endpoint; useful as a diagnose/classify
        // fallback with an uncorrelated error distribution.
        id: 'openai/gpt-oss-20b',
        totalParamsB: 21,
        paramsSource: 'gpt-oss model card: 21B total / 3.6B active',
        contextTokens: 128_000,
        costPerMTokIn: 0, costPerMTokOut: 0,
        roles: ['classify', 'diagnose', 'ask'],
      },
    ],
  },

  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    enabled: true,
    preference: 'user',
    // 100k tokens/day makes Groq unusable as the executor, but it serves the
    // small high-volume classify/diagnose calls extremely fast.
    limits: {
      requestsPerMinute: 30, tokensPerMinute: 12_000,
      requestsPerDay: 1_000, tokensPerDay: 100_000,
    },
    models: [
      {
        id: 'llama-3.3-70b-versatile',
        totalParamsB: 70,
        paramsSource: 'Meta model card: Llama 3.3 70B',
        contextTokens: 128_000,
        costPerMTokIn: 0, costPerMTokOut: 0,
        roles: ['plan', 'diagnose', 'ask'],
      },
      {
        id: 'qwen/qwen3-32b',
        totalParamsB: 32,
        paramsSource: 'Qwen3 model card: 32B dense',
        contextTokens: 128_000,
        costPerMTokIn: 0, costPerMTokOut: 0,
        roles: ['classify', 'execute', 'ask'],
      },
      {
        id: 'openai/gpt-oss-20b',
        totalParamsB: 21,
        paramsSource: 'gpt-oss model card: 21B total / 3.6B active',
        contextTokens: 128_000,
        costPerMTokIn: 0, costPerMTokOut: 0,
        roles: ['classify', 'ask'],
      },
    ],
  },

  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    enabled: true,
    preference: 'user',
    // One key reaches free AND paid models, so a single key still exercises
    // cross-model routing, the $0 path, and the paid overflow tier.
    limits: { requestsPerMinute: 20, requestsPerDay: 1_000 },
    models: [
      {
        id: 'qwen/qwen3-coder:free',
        totalParamsB: 30,
        paramsSource: 'Qwen3-Coder-30B-A3B model card: 30B total / 3B active',
        contextTokens: 256_000,
        costPerMTokIn: 0, costPerMTokOut: 0,
        roles: ['execute', 'plan'],
      },
      {
        // Paid overflow: used only when the pay-vs-wait rule says the wait
        // costs more score than the dollars do. See router.ts.
        id: 'qwen/qwen3-coder',
        totalParamsB: 30,
        paramsSource: 'Qwen3-Coder-30B-A3B model card: 30B total / 3B active',
        contextTokens: 256_000,
        costPerMTokIn: 0.20, costPerMTokOut: 0.80,
        roles: ['execute', 'plan'],
      },
      {
        id: 'mistralai/devstral-small',
        totalParamsB: 24,
        paramsSource: 'Mistral model card: Devstral Small 24B',
        contextTokens: 128_000,
        costPerMTokIn: 0.07, costPerMTokOut: 0.28,
        roles: ['execute'],
      },
    ],
  },

  {
    id: 'ollama',
    label: 'Local (Ollama)',
    baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
    keyEnv: null,
    // Off by default: routing to a local model that is not installed gives a
    // confusing connection error. Flip to true once `ollama pull` has run.
    enabled: false,
    preference: 'floor',
    limits: {},
    notes: 'Zero-key floor. The 16GB RAM / 8GB VRAM limit means a ~7B model at ' +
           'Q4. Too weak to lead; used when no key is configured or every ' +
           'remote bucket is exhausted.',
    models: [
      {
        id: 'qwen2.5-coder:7b',
        totalParamsB: 7,
        paramsSource: 'Qwen2.5-Coder model card: 7B dense',
        contextTokens: 32_000,
        costPerMTokIn: 0, costPerMTokOut: 0,
        roles: ['classify', 'plan', 'execute', 'diagnose', 'ask'],
      },
    ],
  },

  {
    id: 'mistral',
    label: 'Mistral (La Plateforme)',
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnv: 'MISTRAL_API_KEY',
    enabled: false,
    preference: 'user',
    // ~1B tokens/month free but only ~2 requests/minute: huge volume, brutal
    // request rate. (Mistral Large is 123B and therefore illegal here.)
    limits: { requestsPerMinute: 2 },
    models: [
      {
        id: 'devstral-small-latest',
        totalParamsB: 24,
        paramsSource: 'Mistral model card: Devstral Small 24B',
        contextTokens: 128_000,
        costPerMTokIn: 0, costPerMTokOut: 0,
        roles: ['execute'],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Lookups and compliance
// ---------------------------------------------------------------------------

export interface Candidate {
  provider: ProviderSpec;
  model: ModelSpec;
}

export function getProvider(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function getModel(providerId: string, modelId: string): ModelSpec | undefined {
  return getProvider(providerId)?.models.find((m) => m.id === modelId);
}

/** Every enabled (provider, model) pair that can serve `role`. */
export function candidatesForRole(role: Role): Candidate[] {
  return PROVIDERS.filter((p) => p.enabled).flatMap((provider) =>
    provider.models
      .filter((model) => model.roles.includes(role))
      .map((model) => ({ provider, model })));
}

/** Estimated dollars for a call of this shape. Drives pay-vs-wait. */
export function estimateCostUsd(model: ModelSpec, tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1e6) * model.costPerMTokIn + (tokensOut / 1e6) * model.costPerMTokOut;
}

/**
 * Refuse to run a build whose catalogue violates the 80B limit. A hard throw,
 * not a warning: the constraint is a disqualifier. Excluded on this rule:
 * Llama 4 Scout (109B total), Mistral Large (123B), gpt-oss-120b, DeepSeek,
 * Kimi K2 — and any model with no published parameter count (compliance must
 * be evidenced, not assumed).
 */
export function assertLegalCatalogue(): void {
  const illegal = PROVIDERS.flatMap((p) =>
    p.models
      .filter((m) => m.totalParamsB > MAX_TOTAL_PARAMS_B)
      .map((m) => `${p.id}/${m.id} = ${m.totalParamsB}B`));
  if (illegal.length > 0) {
    throw new Error(
      `Model catalogue violates the ${MAX_TOTAL_PARAMS_B}B limit:\n  ${illegal.join('\n  ')}`);
  }
}
