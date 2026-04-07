/**
 * Tier Classifier — determines which model tier (0–3) to use for a message.
 * Pure code, no AI call. Runs before every chat request.
 *
 * Tier 0: handled by code, no AI
 * Tier 1: commodity (Gemini Flash-Lite / DeepSeek)
 * Tier 2: workhorse (Gemini Pro / Sonnet)
 * Tier 3: premium (Opus — only on escalation)
 */

import { TASK_MAX_TOKENS } from './models.js';

// ── Pattern tables ────────────────────────────────────────────────────────────

const TIER_0_PATTERNS = [
  /^(toggle|mark|check|uncheck|done|complete)\b/i,
  /^(show|list|display|what('s| is) my)\b.*\b(tasks?|deadlines?|status|calendar|schedule)/i,
  /^(open|launch|start)\b/i,
  /^(set timer|start timer)/i,
  /^(move .+ to (backlog|drafting|review|submitted))/i,
];

const TIER_3_EXPLICIT = [
  /\b(go deeper|think harder|more nuance|unpack this|let'?s explore)\b/i,
  /\b(what do you (really )?think|devil'?s advocate|challenge (my|this))\b/i,
  /\b(help me (develop|articulate|formulate|think through))\b/i,
];

const TIER_3_TOPICS = [
  /\b(research (statement|direction|question|position|agenda))\b/i,
  /\b(philosophy|epistemolog|ontolog|phenomenolog)/i,
  /\b(alignment (problem|tax|research))\b/i,
  /\b(paper|thesis|dissertation|manuscript)\b.*(review|critique|feedback|opinion)/i,
  /\b(what('s| is) (wrong|flawed|missing) (with|in) (this|the))\b/i,
];

const TIER_3_PUSHBACK = [
  /\b(but why|that'?s not (right|quite)|I disagree|not convinced)\b/i,
  /\b(can you (explain|elaborate) (more|further|why))\b/i,
  /\b(what about|have you considered|isn'?t it (true|possible))\b/i,
];

const TIER_1_PATTERNS = [
  /^(route|classify|categorize|tag|label)\b/i,
  /\b(which project|where does this go)\b/i,
  /\b(remind me|add to calendar|set reminder)\b/i,
  /\b(extract|parse|pull out)\b.*(url|link|date|deadline)/i,
];

// Conversation depth at which we escalate learning/reading to Opus
const DEPTH_ESCALATION_THRESHOLD = 6;

// ── Classifier ────────────────────────────────────────────────────────────────

/**
 * @param {string} message
 * @param {{
 *   projectKey?: string,
 *   messageCount?: number,
 *   recentMessages?: string[],
 *   isEscalated?: boolean
 * }} context
 * @returns {{ tier: number, model: string|null, reason: string, maxTokens: number }}
 */
export function classifyTier(message, context = {}) {
  const {
    projectKey    = null,
    messageCount  = 0,
    recentMessages = [],
    isEscalated   = false,
  } = context;

  // ── Tier 0: no AI needed ──────────────────────────────────────────────────
  for (const p of TIER_0_PATTERNS) {
    if (p.test(message)) {
      return { tier: 0, model: null, reason: 'Code-only task — no AI needed', maxTokens: 0 };
    }
  }

  // ── Sticky escalation: once in Opus, stay there unless it's logistics ─────
  if (isEscalated) {
    const isLogistics = /\b(add (to|that)|calendar|remind|schedule|save|done|ok (next|thanks))\b/i.test(message);
    if (isLogistics) {
      return { tier: 1, model: 'haiku', reason: 'De-escalated: logistics task during Opus session', maxTokens: TASK_MAX_TOKENS.notification };
    }
    return { tier: 3, model: 'opus', reason: 'Sticky escalation — maintaining Opus for ongoing deep discussion', maxTokens: TASK_MAX_TOKENS.socratic_chat };
  }

  // ── Tier 3: escalation signals ────────────────────────────────────────────
  for (const p of TIER_3_EXPLICIT) {
    if (p.test(message)) {
      return { tier: 3, model: 'opus', reason: 'Explicit escalation request', maxTokens: TASK_MAX_TOKENS.socratic_chat };
    }
  }
  for (const p of TIER_3_TOPICS) {
    if (p.test(message)) {
      return { tier: 3, model: 'opus', reason: 'High-complexity research/philosophy topic', maxTokens: TASK_MAX_TOKENS.research_polish };
    }
  }
  for (const p of TIER_3_PUSHBACK) {
    if (p.test(message) && messageCount > 2) {
      return { tier: 3, model: 'opus', reason: 'User pushback — escalating for better reasoning', maxTokens: TASK_MAX_TOKENS.socratic_chat };
    }
  }
  if (messageCount > DEPTH_ESCALATION_THRESHOLD && (projectKey === 'reading' || projectKey === 'learning_tech')) {
    return { tier: 3, model: 'opus', reason: 'Deep conversation in learning/reading project', maxTokens: TASK_MAX_TOKENS.socratic_chat };
  }

  // ── Tier 1: simple structured tasks ──────────────────────────────────────
  for (const p of TIER_1_PATTERNS) {
    if (p.test(message)) {
      return { tier: 1, model: 'gemini-flash-lite', reason: 'Simple structured task', maxTokens: TASK_MAX_TOKENS.routing };
    }
  }
  if (message.split(/\s+/).length < 10 && !message.includes('?')) {
    return { tier: 1, model: 'gemini-flash-lite', reason: 'Short command-like message', maxTokens: TASK_MAX_TOKENS.routing };
  }

  // ── Tier 2: default ───────────────────────────────────────────────────────
  // Gemini Pro for learning/reading (cheaper + 1M context window)
  // Sonnet for research_apps (better at structured drafting)
  if (projectKey === 'learning_tech' || projectKey === 'reading') {
    return { tier: 2, model: 'gemini-pro', reason: 'Learning/reading project — Gemini Pro (cost + context)', maxTokens: TASK_MAX_TOKENS.default };
  }
  if (projectKey === 'research_apps') {
    return { tier: 2, model: 'sonnet', reason: 'Research apps — Sonnet for structured drafting', maxTokens: TASK_MAX_TOKENS.answer_draft };
  }

  return { tier: 2, model: 'sonnet', reason: 'Default workhorse', maxTokens: TASK_MAX_TOKENS.default };
}
