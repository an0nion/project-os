/**
 * Model Registry — single source of truth for all AI model configuration.
 * Tier 0: no AI | Tier 1: free/near-free | Tier 2: workhorse | Tier 3: premium
 */

export const MODELS = {
  // ── Tier 1: Free / Near-Free ──────────────────────────────────────────────
  'gemini-flash': {
    provider:      'google',
    model:         'gemini-2.0-flash-lite',
    inputCost:     0.075,   // per 1M tokens
    outputCost:    0.30,
    maxOutput:     1024,
    contextWindow: 1_048_576,
    tier:          1,
    notes:         'FREE tier: 1,000 req/day. Primary Tier 1 model.',
  },
  'deepseek-chat': {
    provider:      'deepseek',
    model:         'deepseek-chat',   // V3.2
    inputCost:     0.14,
    outputCost:    0.28,
    maxOutput:     4096,
    contextWindow: 65_536,
    tier:          1.5,  // Cheap enough for Tier 1, capable enough for Tier 2
    notes:         'Fallback for Tier 1 if Google quota exhausted. Primary for Tier 2.',
  },

  // ── Tier 2: Workhorse ─────────────────────────────────────────────────────
  'sonnet': {
    provider:      'anthropic',
    model:         'claude-sonnet-4-20250514',
    inputCost:     3.00,
    outputCost:    15.00,
    maxOutput:     8192,
    contextWindow: 200_000,
    tier:          2,
    notes:         'Tier 2 fallback. Use when DeepSeek quality insufficient or for tool calling.',
  },

  // ── Tier 3: Premium ───────────────────────────────────────────────────────
  'opus': {
    provider:      'anthropic',
    model:         'claude-opus-4-6',
    inputCost:     5.00,
    outputCost:    25.00,
    maxOutput:     8192,
    contextWindow: 200_000,
    tier:          3,
    notes:         'ONLY via escalation. ALWAYS with prompt caching. NEVER as default.',
  },
};

export const PROVIDERS = {
  google: {
    envKey:     'GOOGLE_AI_API_KEY',
    freeQuota:  1000,   // requests per day
  },
  deepseek: {
    envKey: 'DEEPSEEK_API_KEY',
  },
  anthropic: {
    envKey:        'ANTHROPIC_API_KEY',
    supportsCache: true,
    supportsBatch: true,
  },
};
