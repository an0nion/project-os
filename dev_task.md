# DEVELOPER MEMO — Multi-Model Architecture & Cost Optimization

**Date:** April 7, 2026  
**From:** Product  
**To:** Dev Team  
**Priority:** High  
**Subject:** Implement tiered model routing, cost reduction pipeline, and multi-provider API integration

---

## 1. Summary

We are moving from a single-model architecture (Claude Sonnet for everything) to
a tiered multi-model system that routes each request to the cheapest model capable
of handling it. The primary user is an AI researcher who has long, intellectually
deep conversations — especially around learning and research ideation. This is our
most expensive use case and the one we must optimize most aggressively.

**Target:** Reduce monthly AI API cost from ~$50-80 (Opus for everything) to
~$8-24/month while maintaining Opus-quality responses where they actually matter.

---

## 2. New API Keys Required

Add these to `.env.local` and Vercel environment variables:

```bash
# ── Existing (keep) ──
ANTHROPIC_API_KEY=sk-ant-...        # Claude Haiku, Sonnet, Opus

# ── New: Google AI ──
GOOGLE_AI_API_KEY=...               # Gemini Flash-Lite, Flash, 2.5 Pro
# Get from: https://aistudio.google.com/apikey
# Free tier: 1,000 requests/day on Flash models
# Paid: pay-as-you-go, no minimum

# ── New: DeepSeek ──
DEEPSEEK_API_KEY=...                # DeepSeek V3.2, R1
# Get from: https://platform.deepseek.com/api_keys
# Pricing: $0.14/$0.28 per million tokens (V3.2)
# Top up: minimum $5 credit
```

**Do NOT add OpenAI/GPT keys** — we don't need a third paid provider. The
combination of Claude (3 tiers) + Gemini (free tier + paid) + DeepSeek (ultra-cheap)
covers every price point.

---

## 3. Model Registry

Create a new file `lib/models.js` that centralizes all model configuration:

```javascript
// lib/models.js

export const MODELS = {
  // ── Tier 0: No AI ──
  // No model needed — pure code logic

  // ── Tier 1: Commodity (routing, classification, extraction) ──
  'gemini-flash-lite': {
    provider: 'google',
    model: 'gemini-2.0-flash-lite',
    inputCost: 0.075,    // per 1M tokens
    outputCost: 0.30,
    maxTokens: 8192,
    contextWindow: 1048576,
    tier: 1,
    capabilities: ['routing', 'classification', 'extraction', 'simple_generation'],
    notes: 'Free tier: 1000 req/day. Use as default for all Tier 1 tasks.',
  },
  'deepseek-v3': {
    provider: 'deepseek',
    model: 'deepseek-chat',
    inputCost: 0.14,
    outputCost: 0.28,
    maxTokens: 8192,
    contextWindow: 65536,
    tier: 1,
    capabilities: ['routing', 'classification', 'extraction', 'tool_calling'],
    notes: 'Cheapest capable model. Good fallback if Gemini free tier is exhausted.',
  },
  'haiku': {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    inputCost: 0.80,
    outputCost: 4.00,
    maxTokens: 8192,
    contextWindow: 200000,
    tier: 1,
    capabilities: ['routing', 'classification', 'extraction', 'tool_calling'],
    notes: 'Best tool calling reliability. Use when structured output matters.',
  },

  // ── Tier 2: Workhorse (drafting, planning, summarization, light chat) ──
  'sonnet': {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    inputCost: 3.00,
    outputCost: 15.00,
    maxTokens: 8192,
    contextWindow: 200000,
    tier: 2,
    capabilities: ['drafting', 'planning', 'summarization', 'conversation', 'tool_calling'],
    notes: 'Primary workhorse. Reliable, good quality, reasonable cost.',
  },
  'gemini-pro': {
    provider: 'google',
    model: 'gemini-2.5-pro',
    inputCost: 1.25,
    outputCost: 10.00,
    maxTokens: 8192,
    contextWindow: 1048576,
    tier: 2,
    capabilities: ['drafting', 'conversation', 'summarization', 'long_context'],
    notes: '1M context. Cheaper than Sonnet. Good for long learning sessions.',
  },

  // ── Tier 3: Premium (ideation, deep learning, research, high-stakes) ──
  'opus': {
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    inputCost: 5.00,
    outputCost: 25.00,
    maxTokens: 8192,
    contextWindow: 200000,
    tier: 3,
    capabilities: ['ideation', 'deep_reasoning', 'nuanced_writing', 'research', 'teaching'],
    notes: 'Use ONLY when escalated. Never as default. Always with prompt caching.',
  },
};

export const PROVIDER_CONFIGS = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1/messages',
    authHeader: 'x-api-key',
    envKey: 'ANTHROPIC_API_KEY',
    supportsCache: true,
    supportsBatch: true,
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authHeader: null, // uses ?key= param
    envKey: 'GOOGLE_AI_API_KEY',
    supportsCache: false,
    supportsBatch: false,
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    authHeader: 'Authorization', // Bearer token
    envKey: 'DEEPSEEK_API_KEY',
    supportsCache: true,
    supportsBatch: false,
  },
};
```

---

## 4. Tier Classification Logic

Create `lib/tierClassifier.js`. This runs BEFORE any AI call to determine which
model to use. It's pure code — no AI call needed for classification itself.

```javascript
// lib/tierClassifier.js

// ── Keywords and patterns for each tier ──

const TIER_0_PATTERNS = [
  // These are handled by code, no AI needed
  /^(toggle|mark|check|uncheck|done|complete)\b/i,
  /^(show|list|display|what('s| is) my)\b.*\b(tasks?|deadlines?|status|calendar|schedule)/i,
  /^(open|launch|start)\b/i,
  /^(set timer|start timer)/i,
  /^(move .+ to (backlog|drafting|review|submitted))/i,
];

const TIER_3_SIGNALS = {
  // Explicit escalation
  explicit: [
    /\b(go deeper|think harder|more nuance|unpack this|let'?s explore)\b/i,
    /\b(what do you (really )?think|devil'?s advocate|challenge (my|this))\b/i,
    /\b(help me (develop|articulate|formulate|think through))\b/i,
  ],
  // Topic-based escalation
  topics: [
    /\b(research (statement|direction|question|position|agenda))\b/i,
    /\b(philosophy|epistemolog|ontolog|phenomenolog)/i,
    /\b(alignment (problem|tax|research))\b/i,
    /\b(paper|thesis|dissertation|manuscript)\b.*(review|critique|feedback|opinion)/i,
    /\b(what('s| is) (wrong|flawed|missing) (with|in) (this|the))\b/i,
  ],
  // Conversational escalation (detected from history, not single message)
  conversationDepthThreshold: 6,  // After 6 messages on same topic, consider upgrading
  pushbackPatterns: [
    /\b(but why|that'?s not (right|quite)|I disagree|not convinced)\b/i,
    /\b(can you (explain|elaborate) (more|further|why))\b/i,
    /\b(what about|have you considered|isn'?t it (true|possible))\b/i,
  ],
};

const TIER_1_PATTERNS = [
  /^(route|classify|categorize|tag|label)\b/i,
  /\b(which project|where does this go)\b/i,
  /\b(remind me|add to calendar|set reminder)\b/i,
  /\b(extract|parse|pull out)\b.*(url|link|date|deadline)/i,
];

/**
 * Classify a message into a model tier.
 *
 * @param {string} message - The user's message
 * @param {object} context - Conversation context
 * @param {string} context.projectKey - Current project
 * @param {number} context.messageCount - Messages in current conversation
 * @param {string[]} context.recentMessages - Last 3 messages for pattern detection
 * @param {boolean} context.isEscalated - Whether conversation was previously escalated
 * @returns {{ tier: number, model: string, reason: string }}
 */
export function classifyTier(message, context = {}) {
  const { projectKey, messageCount = 0, recentMessages = [], isEscalated = false } = context;

  // ── Tier 0: No AI needed ──
  for (const pattern of TIER_0_PATTERNS) {
    if (pattern.test(message)) {
      return { tier: 0, model: null, reason: 'Code-only task, no AI needed' };
    }
  }

  // ── Tier 3: Check for escalation signals ──

  // If already escalated in this conversation, stay escalated
  // (don't yo-yo between models mid-discussion)
  if (isEscalated) {
    // BUT: de-escalate if the message is clearly logistics
    const isLogistics = /\b(add (to|that)|calendar|remind|schedule|save|done|ok (next|thanks))\b/i.test(message);
    if (isLogistics) {
      return { tier: 1, model: 'haiku', reason: 'De-escalated: logistics task during Opus session' };
    }
    return { tier: 3, model: 'opus', reason: 'Sticky escalation: maintaining Opus for ongoing deep discussion' };
  }

  // Explicit escalation request
  for (const pattern of TIER_3_SIGNALS.explicit) {
    if (pattern.test(message)) {
      return { tier: 3, model: 'opus', reason: 'Explicit escalation request detected' };
    }
  }

  // Topic-based escalation
  for (const pattern of TIER_3_SIGNALS.topics) {
    if (pattern.test(message)) {
      return { tier: 3, model: 'opus', reason: 'High-complexity research/philosophy topic detected' };
    }
  }

  // Pushback escalation (user disagreeing = they need a smarter model)
  for (const pattern of TIER_3_SIGNALS.pushbackPatterns) {
    if (pattern.test(message) && messageCount > 2) {
      return { tier: 3, model: 'opus', reason: 'User pushback detected — escalating for better reasoning' };
    }
  }

  // Conversation depth escalation
  if (messageCount > TIER_3_SIGNALS.conversationDepthThreshold && projectKey === 'reading') {
    return { tier: 3, model: 'opus', reason: 'Deep conversation in learning/reading project' };
  }

  // ── Tier 1: Simple structured tasks ──
  for (const pattern of TIER_1_PATTERNS) {
    if (pattern.test(message)) {
      return { tier: 1, model: 'gemini-flash-lite', reason: 'Simple structured task' };
    }
  }

  // Message is very short (< 15 words) and looks like a command
  if (message.split(/\s+/).length < 10 && !message.includes('?')) {
    return { tier: 1, model: 'gemini-flash-lite', reason: 'Short command-like message' };
  }

  // ── Tier 2: Default for everything else ──
  // Use Gemini Pro for learning/reading projects (cheaper, 1M context)
  // Use Sonnet for research_apps (better at structured drafting)
  if (projectKey === 'learning_tech' || projectKey === 'reading') {
    return { tier: 2, model: 'gemini-pro', reason: 'Learning/reading project — Gemini Pro for cost + context' };
  }

  return { tier: 2, model: 'sonnet', reason: 'Default workhorse task' };
}
```

---

## 5. Multi-Provider API Client

Create `lib/multiModelClient.js`. This is the single function all API routes call
instead of the current `chat()` function. It handles routing to the correct provider.

```javascript
// lib/multiModelClient.js

import { MODELS, PROVIDER_CONFIGS } from './models.js';

/**
 * Send a chat completion to any provider.
 * Unified interface — caller doesn't need to know which provider is being used.
 */
export async function chatWithModel(modelKey, { system, messages, maxTokens = 1500 }) {
  const modelConfig = MODELS[modelKey];
  if (!modelConfig) throw new Error(`Unknown model: ${modelKey}`);

  const providerConfig = PROVIDER_CONFIGS[modelConfig.provider];
  const apiKey = process.env[providerConfig.envKey];
  if (!apiKey) throw new Error(`Missing API key: ${providerConfig.envKey}`);

  switch (modelConfig.provider) {
    case 'anthropic':
      return callAnthropic(modelConfig, apiKey, { system, messages, maxTokens });
    case 'google':
      return callGoogle(modelConfig, apiKey, { system, messages, maxTokens });
    case 'deepseek':
      return callDeepSeek(modelConfig, apiKey, { system, messages, maxTokens });
    default:
      throw new Error(`Unknown provider: ${modelConfig.provider}`);
  }
}

// ── Anthropic (Claude) ──
async function callAnthropic(modelConfig, apiKey, { system, messages, maxTokens }) {
  const body = {
    model: modelConfig.model,
    max_tokens: maxTokens,
    messages,
  };

  // Add system prompt with caching if supported
  // Prompt caching: mark the system prompt as cacheable
  // This saves 90% on input costs for repeated system prompts
  if (system) {
    body.system = [
      {
        type: 'text',
        text: system,
        cache_control: { type: 'ephemeral' },  // Enable prompt caching
      }
    ];
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',  // Enable caching
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic ${response.status}: ${err}`);
  }

  const data = await response.json();
  return {
    text: data.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || '',
    usage: data.usage,
    model: modelConfig.model,
    provider: 'anthropic',
    cached: data.usage?.cache_read_input_tokens > 0,
  };
}

// ── Google (Gemini) ──
async function callGoogle(modelConfig, apiKey, { system, messages, maxTokens }) {
  // Convert from Anthropic message format to Gemini format
  const geminiMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = {
    contents: geminiMessages,
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 0.7,
    },
  };

  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelConfig.model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || '';

  return {
    text,
    usage: {
      input_tokens: data.usageMetadata?.promptTokenCount || 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
    },
    model: modelConfig.model,
    provider: 'google',
    cached: false,
  };
}

// ── DeepSeek ──
async function callDeepSeek(modelConfig, apiKey, { system, messages, maxTokens }) {
  // DeepSeek uses OpenAI-compatible API format
  const dsMessages = [];
  if (system) {
    dsMessages.push({ role: 'system', content: system });
  }
  dsMessages.push(...messages);

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelConfig.model,
      messages: dsMessages,
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DeepSeek ${response.status}: ${err}`);
  }

  const data = await response.json();
  return {
    text: data.choices?.[0]?.message?.content || '',
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
    model: modelConfig.model,
    provider: 'deepseek',
    cached: data.usage?.prompt_cache_hit_tokens > 0,
  };
}
```

---

## 6. Cost Reduction Pipeline

These are not optional optimizations — implement ALL of them.

### 6.1 Prompt Caching (90% input savings on repeated prompts)

**What it does:** The system prompt + user profile + project context is identical
across every message in a conversation. With caching, Anthropic charges 10% of
the normal input rate for cached tokens.

**Implementation:** Already included in the `callAnthropic` function above via
the `cache_control: { type: 'ephemeral' }` field on the system prompt. The
`anthropic-beta: prompt-caching-2024-07-31` header enables it.

**Impact:** On a conversation with a 3,000-token system prompt, each message
after the first saves ~$0.0135 in input costs. Over a 20-message conversation,
that's $0.27 saved — roughly 60% of total input costs.

**Action required:**
- Ensure ALL Anthropic API calls use the caching format shown above
- Structure system prompts so the static portion (profile, project config, rules)
  comes first, and dynamic portion (current tasks, recent context) comes last
- Static portion gets cached; dynamic portion does not

### 6.2 Rolling Conversation Summary (20x input reduction on long chats)

**What it does:** Instead of sending the full conversation history with every
message, compress older messages into a summary. The user keeps chatting
indefinitely, but you never send more than ~1,500 tokens of history.

**Implementation:**

```javascript
// lib/conversationManager.js

const SUMMARY_THRESHOLD = 8;     // Summarize after this many messages
const KEEP_RECENT = 3;           // Always keep the last N messages in full

export async function manageConversationHistory(messages) {
  if (messages.length <= SUMMARY_THRESHOLD) {
    return messages;  // Short conversation, send everything
  }

  // Split: old messages to summarize, recent messages to keep
  const toSummarize = messages.slice(0, -KEEP_RECENT);
  const toKeep = messages.slice(-KEEP_RECENT);

  // Use a Tier 1 model to summarize (cheap)
  const { chatWithModel } = await import('./multiModelClient.js');
  const summary = await chatWithModel('gemini-flash-lite', {
    system: 'Summarize this conversation in 150 words. Capture key decisions, facts shared, and the current direction of discussion. Do not add commentary.',
    messages: [
      {
        role: 'user',
        content: toSummarize.map(m => `${m.role}: ${m.content}`).join('\n'),
      },
    ],
    maxTokens: 200,
  });

  // Return: summary as first message + recent messages
  return [
    { role: 'user', content: `[Previous conversation summary: ${summary.text}]` },
    { role: 'assistant', content: 'Understood, I have the context from our earlier discussion.' },
    ...toKeep,
  ];
}
```

**Impact:** A 40-message conversation normally sends ~30,000 tokens of history
per message by the end. With rolling summaries, it's always ~1,500 tokens.
That's a **20x reduction** in input costs for long conversations.

**Action required:**
- Call `manageConversationHistory()` in the chat API route before sending to any model
- Store the current summary in the database so it persists across page reloads
- Add a `conversation_summary` column to the `messages` table or store it in
  project metadata

### 6.3 Batch API (50% off for background tasks)

**What it does:** Anthropic's Batch API processes requests asynchronously (up to
24 hours) at half price. Perfect for tasks the user doesn't need immediately.

**Batch-eligible tasks:**
- Summarizing articles saved during the day → process overnight
- Generating draft application answers → process when deadline is 7+ days out
- Building study plans from saved resources
- Extracting questions from scraped applications
- Generating the morning briefing

**Implementation:**

```javascript
// lib/batchQueue.js

export async function queueBatchJob(jobs) {
  // jobs = [{ system, messages, metadata }]
  const apiKey = process.env.ANTHROPIC_API_KEY;

  const requests = jobs.map((job, i) => ({
    custom_id: `job-${i}-${Date.now()}`,
    params: {
      model: 'claude-sonnet-4-20250514',
      max_tokens: job.maxTokens || 1500,
      system: job.system,
      messages: job.messages,
    },
  }));

  const response = await fetch('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ requests }),
  });

  const data = await response.json();
  return data; // Returns batch_id to poll for results
}

export async function checkBatchResults(batchId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const response = await fetch(`https://api.anthropic.com/v1/messages/batches/${batchId}`, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });
  return response.json();
}
```

**Action required:**
- Create a `batch_jobs` table in Supabase to track pending/completed batches
- Modify the cron job to submit batch jobs for overnight processing
- Add a batch results poller that runs every hour (or on next user login)

### 6.4 Max Token Limits (prevent runaway costs)

**Set explicit `max_tokens` per task type:**

| Task | max_tokens | Reasoning |
|------|-----------|-----------|
| Routing classification | 150 | JSON response, very short |
| Calendar event generation | 200 | Title + description + time |
| Question categorization | 100 | Single word category |
| Notification text | 150 | 1-2 sentences |
| Application answer draft | 800 | 200-400 words |
| Study plan | 1500 | Structured list |
| Socratic conversation | 600 | 2-4 sentences per response |
| Research statement polish | 2000 | Full paragraphs |
| Conversation summary | 200 | Compressed summary |

**Action required:**
- Update all API calls to use task-appropriate max_tokens
- Add to the tier classifier output: `{ tier, model, reason, maxTokens }`

### 6.5 Gemini Free Tier (1,000 free requests/day)

**What it does:** Google gives 1,000 free API calls per day on Flash models.
Route ALL Tier 1 tasks through Gemini Flash-Lite first. If the free tier is
exhausted, fall back to DeepSeek V3.2.

**Implementation:**

```javascript
// In the multi-model client, add rate tracking:
let geminiCallsToday = 0;
let geminiResetDate = new Date().toDateString();

function getGeminiFreeQuota() {
  if (new Date().toDateString() !== geminiResetDate) {
    geminiCallsToday = 0;
    geminiResetDate = new Date().toDateString();
  }
  return 1000 - geminiCallsToday;
}

// In tier classifier, if Tier 1:
// if (getGeminiFreeQuota() > 0) → use gemini-flash-lite
// else → use deepseek-v3
```

**Action required:**
- Track daily Gemini call count in memory or a simple DB counter
- Add fallback logic in the classifier

---

## 7. Updated Chat API Route

Here's how the chat endpoint should work with the new system:

```javascript
// app/api/chat/route.js

import { NextResponse } from 'next/server';
import { classifyTier } from '../../../lib/tierClassifier.js';
import { chatWithModel } from '../../../lib/multiModelClient.js';
import { manageConversationHistory } from '../../../lib/conversationManager.js';
import { PROJECTS } from '../../../lib/projects.js';
import { getMessages, addMessage, getProfile, getTasks } from '../../../lib/supabase.js';

export async function POST(req) {
  try {
    const { projectKey, message } = await req.json();
    if (!projectKey || !message) {
      return NextResponse.json({ error: 'projectKey and message required' }, { status: 400 });
    }

    // 1. Save user message
    await addMessage(projectKey, 'user', message).catch(() => {});

    // 2. Get conversation history
    const history = await getMessages(projectKey, 50).catch(() => []);

    // 3. Classify tier
    const classification = classifyTier(message, {
      projectKey,
      messageCount: history.length,
      recentMessages: history.slice(-3).map(m => m.content),
      isEscalated: history.some(m => m.metadata?.tier === 3),
    });

    // 4. Tier 0: handle without AI
    if (classification.tier === 0) {
      // Handle code-only tasks here
      const responseText = `Done. (Handled without AI — ${classification.reason})`;
      await addMessage(projectKey, 'assistant', responseText, { tier: 0 }).catch(() => {});
      return NextResponse.json({
        message: responseText,
        tier: 0,
        model: null,
        reason: classification.reason,
      });
    }

    // 5. Build context
    const [profile, tasks] = await Promise.all([
      getProfile().catch(() => null),
      getTasks(projectKey).catch(() => []),
    ]);

    const projectDef = PROJECTS.find(p => p.key === projectKey);
    let systemPrompt = projectDef?.system_prompt || 'You are a helpful assistant.';

    if (tasks.length > 0) {
      systemPrompt += `\n\nCurrent tasks:\n${tasks.slice(0, 15).map(t => `- [${t.status}] ${t.text}`).join('\n')}`;
    }
    if (profile) {
      systemPrompt += `\n\nUser profile:\n${JSON.stringify(profile, null, 2)}`;
    }

    // Tier-specific instructions
    if (classification.tier === 1) {
      systemPrompt += '\n\nRespond in 1-2 sentences maximum. Be extremely concise.';
    } else if (classification.tier === 2) {
      systemPrompt += '\n\nKeep responses to 2-4 sentences. Be direct, no filler.';
    } else if (classification.tier === 3) {
      systemPrompt += '\n\nThis is a deep discussion. Take your time. Be thorough, nuanced, and intellectually honest. Challenge assumptions when appropriate.';
    }

    // 6. Manage conversation history (rolling summary for long conversations)
    const apiMessages = history.map(m => ({
      role: m.role === 'system' ? 'user' : m.role,
      content: m.content,
    }));
    const managedMessages = await manageConversationHistory(apiMessages);

    // 7. Call the selected model
    const result = await chatWithModel(classification.model, {
      system: systemPrompt,
      messages: managedMessages,
      maxTokens: classification.maxTokens || 1500,
    });

    // 8. Save response with metadata
    await addMessage(projectKey, 'assistant', result.text, {
      tier: classification.tier,
      model: result.model,
      provider: result.provider,
      cached: result.cached,
      usage: result.usage,
    }).catch(() => {});

    return NextResponse.json({
      message: result.text,
      tier: classification.tier,
      model: result.model,
      provider: result.provider,
      cached: result.cached,
      reason: classification.reason,
      usage: result.usage,
    });

  } catch (err) {
    console.error('Chat error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
```

---

## 8. Updated Router (Inbox)

The inbox router itself should use a Tier 1 model — don't waste Sonnet on routing:

```javascript
// In app/api/inbox/route.js, update the routeMessage call:

import { chatWithModel } from '../../../lib/multiModelClient.js';

// Replace the current router's chat() call with:
const result = await chatWithModel('gemini-flash-lite', {
  system: ROUTER_SYSTEM_PROMPT,
  messages: [{ role: 'user', content: inputText }],
  maxTokens: 150,  // Routing response is tiny JSON
});
```

---

## 9. Cost Tracking

Add cost tracking so we can monitor spend per tier and optimize further.

```javascript
// lib/costTracker.js

import { MODELS } from './models.js';

export function calculateCost(modelKey, usage) {
  const model = MODELS[modelKey];
  if (!model || !usage) return 0;

  const inputCost = (usage.input_tokens || 0) / 1_000_000 * model.inputCost;
  const outputCost = (usage.output_tokens || 0) / 1_000_000 * model.outputCost;

  return {
    inputCost: Math.round(inputCost * 1_000_000) / 1_000_000,  // 6 decimal places
    outputCost: Math.round(outputCost * 1_000_000) / 1_000_000,
    totalCost: Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000,
    model: model.model,
    tier: model.tier,
  };
}
```

**Action required:**
- Add a `cost_log` table to Supabase:
  ```sql
  CREATE TABLE cost_log (
    id uuid primary key default gen_random_uuid(),
    model text not null,
    provider text not null,
    tier int not null,
    input_tokens int default 0,
    output_tokens int default 0,
    cost_usd numeric(10,6) default 0,
    cached boolean default false,
    project_key text,
    created_at timestamptz default now()
  );
  ```
- Log every API call with cost data
- Build a simple `/api/costs` endpoint that returns daily/weekly/monthly spend
- Add a cost dashboard widget (show: "This month: $X.XX — Tier 1: $X, Tier 2: $X, Tier 3: $X")

---

## 10. Testing the Multi-Model System

Add these tests to the QA console (`/test`):

| # | Test | Expected |
|---|------|----------|
| 1 | Send "mark task as done" | Tier 0, no AI call |
| 2 | Send "route this to the right project: new recipe" | Tier 1, Gemini Flash-Lite |
| 3 | Send "draft my research interests answer" | Tier 2, Sonnet |
| 4 | Send "help me think through my research direction" | Tier 3, Opus |
| 5 | Send "go deeper" after a Tier 2 response | Escalates to Tier 3 |
| 6 | Send "ok add that to my calendar" during Tier 3 | De-escalates to Tier 1 |
| 7 | Long conversation (10+ messages) | Rolling summary kicks in |
| 8 | Same system prompt, 5 calls | Prompt caching on calls 2-5 |
| 9 | Check cost log after all tests | Accurate cost tracking |

**Add to the QA console:** a "Model Inspector" panel that shows, for each response:
- Which tier was selected
- Which model was used
- Why (the reason string)
- Token usage
- Estimated cost
- Whether prompt caching was used

---

## 11. New .env.local Template

```bash
# ── Claude (Haiku, Sonnet, Opus) ──
ANTHROPIC_API_KEY=sk-ant-...

# ── Google AI (Gemini Flash-Lite, Flash, 2.5 Pro) ──
GOOGLE_AI_API_KEY=...

# ── DeepSeek (V3.2 — ultra cheap fallback) ──
DEEPSEEK_API_KEY=...

# ── Supabase ──
SUPABASE_URL=https://odlcstfsfmmjurozzkjg.supabase.co
SUPABASE_KEY=sb_publishable_...
SUPABASE_SERVICE_KEY=sb_secret_...

# ── Slack ──
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_USER_ID=U...

# ── App ──
APP_URL=http://localhost:3000
CRON_SECRET=change-this-to-random-string

# ── Web Push ──
NEXT_PUBLIC_VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_EMAIL=mailto:you@email.com
```

---

## 12. Implementation Order

1. **`lib/models.js`** — model registry (30 min)
2. **`lib/multiModelClient.js`** — multi-provider API client (2 hrs)
3. **`lib/tierClassifier.js`** — tier classification logic (1 hr)
4. **`lib/conversationManager.js`** — rolling summary (1 hr)
5. **Update `app/api/chat/route.js`** — integrate everything (1 hr)
6. **Update `app/api/inbox/route.js`** — use Tier 1 for routing (30 min)
7. **`lib/costTracker.js`** + `cost_log` table (1 hr)
8. **Update QA console** — add model inspector panel (1 hr)
9. **Get Google AI + DeepSeek API keys** — register + add to env (15 min)
10. **Test all 9 scenarios above** (1 hr)

**Total estimated dev time: ~10 hours**

---

## 13. Expected Cost After Implementation

| Component | Before (Sonnet only) | After (tiered) |
|-----------|---------------------|----------------|
| Routing | $1.50/mo | $0 (Gemini free) |
| Tool calls | $1.00/mo | $0.05/mo (Haiku) |
| Drafting | $3.00/mo | $2.00/mo (Sonnet, cached) |
| Light chat | $2.00/mo | $0.50/mo (Gemini Pro) |
| Deep sessions | $0 (wasn't using Opus) | $5-12/mo (Opus, cached) |
| Background | $1.50/mo | $0.75/mo (Sonnet batch) |
| **Total** | **$9/mo** | **$8-15/mo** |

With Opus-quality where it matters, at roughly the same cost as Sonnet-for-everything.

If she's a very heavy user (2+ hours of deep conversation daily), the ceiling is
~$24/month — still 60-70% cheaper than Opus-for-everything.