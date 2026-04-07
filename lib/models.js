/**
 * Model Registry — single source of truth for all AI model configuration.
 * Tier 0: no AI | Tier 1: commodity | Tier 2: workhorse | Tier 3: premium
 *
 * Model IDs updated to current versions (April 2026).
 */

export const MODELS = {
  // ── Tier 1: Commodity ─────────────────────────────────────────────────────
  'gemini-flash-lite': {
    provider:      'google',
    model:         'gemini-2.0-flash-lite',
    inputCost:     0.075,   // per 1M tokens
    outputCost:    0.30,
    maxTokens:     8192,
    contextWindow: 1_048_576,
    tier:          1,
    capabilities:  ['routing', 'classification', 'extraction', 'simple_generation'],
    notes:         'Free tier: 1000 req/day. Default for all Tier 1 tasks.',
  },
  'deepseek-v3': {
    provider:      'deepseek',
    model:         'deepseek-chat',
    inputCost:     0.14,
    outputCost:    0.28,
    maxTokens:     8192,
    contextWindow: 65_536,
    tier:          1,
    capabilities:  ['routing', 'classification', 'extraction', 'tool_calling'],
    notes:         'Cheapest capable model. Fallback if Gemini free tier is exhausted.',
  },
  'haiku': {
    provider:      'anthropic',
    model:         'claude-haiku-4-5-20251001',
    inputCost:     0.80,
    outputCost:    4.00,
    maxTokens:     8192,
    contextWindow: 200_000,
    tier:          1,
    capabilities:  ['routing', 'classification', 'extraction', 'tool_calling'],
    notes:         'Best tool-calling reliability. Use when structured output matters.',
  },

  // ── Tier 2: Workhorse ─────────────────────────────────────────────────────
  'sonnet': {
    provider:      'anthropic',
    model:         'claude-sonnet-4-6',
    inputCost:     3.00,
    outputCost:    15.00,
    maxTokens:     8192,
    contextWindow: 200_000,
    tier:          2,
    capabilities:  ['drafting', 'planning', 'summarization', 'conversation', 'tool_calling'],
    notes:         'Primary workhorse for drafting + structured tasks.',
  },
  'gemini-pro': {
    provider:      'google',
    model:         'gemini-2.5-pro',
    inputCost:     1.25,
    outputCost:    10.00,
    maxTokens:     8192,
    contextWindow: 1_048_576,
    tier:          2,
    capabilities:  ['drafting', 'conversation', 'summarization', 'long_context'],
    notes:         '1M context. Cheaper than Sonnet. Good for long learning/reading sessions.',
  },

  // ── Tier 3: Premium ───────────────────────────────────────────────────────
  'opus': {
    provider:      'anthropic',
    model:         'claude-opus-4-6',
    inputCost:     5.00,
    outputCost:    25.00,
    maxTokens:     8192,
    contextWindow: 200_000,
    tier:          3,
    capabilities:  ['ideation', 'deep_reasoning', 'nuanced_writing', 'research', 'teaching'],
    notes:         'Use ONLY when escalated. Never as default. Always with prompt caching.',
  },
};

export const PROVIDER_CONFIGS = {
  anthropic: {
    baseUrl:       'https://api.anthropic.com/v1/messages',
    authHeader:    'x-api-key',
    envKey:        'ANTHROPIC_API_KEY',
    supportsCache: true,
    supportsBatch: true,
  },
  google: {
    baseUrl:       'https://generativelanguage.googleapis.com/v1beta',
    authHeader:    null,           // uses ?key= query param
    envKey:        'GOOGLE_AI_API_KEY',
    supportsCache: false,
    supportsBatch: false,
  },
  deepseek: {
    baseUrl:       'https://api.deepseek.com/v1/chat/completions',
    authHeader:    'Authorization', // Bearer token
    envKey:        'DEEPSEEK_API_KEY',
    supportsCache: true,
    supportsBatch: false,
  },
};

// max_tokens per task type — prevents runaway costs
export const TASK_MAX_TOKENS = {
  routing:             150,
  calendar_event:      200,
  categorization:      100,
  notification:        150,
  answer_draft:        800,
  study_plan:         1500,
  socratic_chat:       600,
  research_polish:    2000,
  conv_summary:        200,
  default:            1500,
};
