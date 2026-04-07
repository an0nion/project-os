/**
 * Tier Classifier — determines which model tier and models to use for a message.
 * Pure regex, zero AI calls. Runs before every chat request.
 *
 * Returns: { tier, primaryModel, fallbackModel, maxTokens, reason }
 *
 * Tier 0: handled in code, no AI
 * Tier 1: Google free / DeepSeek near-free
 * Tier 2: DeepSeek primary (cheapest capable), Sonnet fallback
 * Tier 3: Opus direct, Sonnet fallback — only on escalation, sticky
 */

// ── Tier 0: No AI needed ──────────────────────────────────────────────────────
const TIER_0 = [
  /^(toggle|mark|check|uncheck|done|complete|finish)\b/i,
  /^(show|list|display|what('s| is) my)\b.*\b(tasks?|deadlines?|status|calendar|progress)/i,
  /^(open|launch|start|go to)\b/i,
  /^(set timer|start timer|set alarm)/i,
  /^(move .+ to (backlog|drafting|review|submitted))/i,
  /^(delete|remove|cancel)\s+(task|event|reminder)/i,
  /^(how many|count)\b/i,
];

// ── Tier 3: Explicit escalation ───────────────────────────────────────────────
const ESCALATE_EXPLICIT = [
  /\b(go deeper|think harder|more nuance|unpack this|let'?s explore)\b/i,
  /\b(what do you (really )?think|devil'?s advocate)\b/i,
  /\b(challenge (my|this)|push back on)\b/i,
  /\b(help me (develop|articulate|formulate|think through|reason))\b/i,
  /\b(steelman|strawman|critique (this|my))\b/i,
];

// ── Tier 3: Topic-based escalation ────────────────────────────────────────────
const ESCALATE_TOPICS = [
  /\b(research (statement|direction|question|position|agenda|proposal))\b/i,
  /\b(philosoph|epistemolog|ontolog|phenomenolog|metaphysic)/i,
  /\b(alignment (problem|tax|research|approach))\b/i,
  /\b(paper|thesis|dissertation)\b.*(review|critique|feedback|opinion|discuss)/i,
  /\b(interpretability|mechanistic|circuit|feature.*analysis)\b/i,
  /\b(what('s| is) (wrong|flawed|missing|weak) (with|in|about))\b/i,
  /\b(original (contribution|insight|framing|argument))\b/i,
];

// ── Tier 3: Pushback (only after 2+ messages) ─────────────────────────────────
const PUSHBACK = [
  /\b(but why|that'?s not (right|quite|exactly)|I disagree|not convinced)\b/i,
  /\b(can you (explain|elaborate) (more|further|deeper|why))\b/i,
  /\b(what about|have you considered|isn'?t it (true|possible))\b/i,
  /\b(I don'?t (think|agree|buy)|that seems (wrong|off|shallow))\b/i,
];

// ── Tier 1: Simple structured tasks ──────────────────────────────────────────
const TIER_1 = [
  /^(route|classify|categorize|tag|label|sort)\b/i,
  /\b(which project|where does this (go|belong))\b/i,
  /\b(remind me|add to calendar|set reminder|schedule)\b/i,
  /\b(extract|parse|pull out)\b.*(url|link|date|deadline|email)/i,
  /\b(format|convert|translate)\b.*\b(to|into|as)\b/i,
  /\b(summarize this in one (line|sentence))\b/i,
];

// ── Classifier ────────────────────────────────────────────────────────────────

/**
 * @param {string} message
 * @param {{ projectKey?: string, messageCount?: number, isEscalated?: boolean }} ctx
 * @returns {{ tier: number, primaryModel: string|null, fallbackModel: string|null, maxTokens: number, reason: string }}
 */
export function classifyTier(message, ctx = {}) {
  const { projectKey = '', messageCount = 0, isEscalated = false } = ctx;

  // ── Tier 0 ──
  for (const p of TIER_0) {
    if (p.test(message)) {
      return { tier: 0, primaryModel: null, fallbackModel: null, maxTokens: 0, reason: 'Code-only task' };
    }
  }

  // ── Tier 3: Sticky escalation ──
  // Once escalated, stay on Opus for the conversation unless clearly logistics
  if (isEscalated) {
    const isLogistics = /\b(add (to|that)|calendar|remind|schedule|save|done|ok (next|thanks|got it)|moving on)\b/i.test(message);
    if (isLogistics) {
      return { tier: 1, primaryModel: 'gemini-flash', fallbackModel: 'deepseek-chat', maxTokens: 300, reason: 'De-escalated: logistics during Opus session' };
    }
    return { tier: 3, primaryModel: 'opus', fallbackModel: 'sonnet', maxTokens: 2000, reason: 'Sticky: maintaining Opus session' };
  }

  // ── Tier 3: Explicit escalation ──
  for (const p of ESCALATE_EXPLICIT) {
    if (p.test(message)) {
      return { tier: 3, primaryModel: 'opus', fallbackModel: 'sonnet', maxTokens: 2000, reason: 'Explicit escalation request' };
    }
  }

  // ── Tier 3: Topic-based ──
  for (const p of ESCALATE_TOPICS) {
    if (p.test(message)) {
      return { tier: 3, primaryModel: 'opus', fallbackModel: 'sonnet', maxTokens: 2000, reason: 'Deep research/philosophy topic' };
    }
  }

  // ── Tier 3: Pushback after 2+ messages ──
  if (messageCount > 2) {
    for (const p of PUSHBACK) {
      if (p.test(message)) {
        return { tier: 3, primaryModel: 'opus', fallbackModel: 'sonnet', maxTokens: 2000, reason: 'User pushback — needs stronger reasoning' };
      }
    }
  }

  // ── Tier 3: Deep conversation in learning/reading projects ──
  if (messageCount > 8 && (projectKey === 'reading' || projectKey === 'learning_tech')) {
    return { tier: 3, primaryModel: 'opus', fallbackModel: 'sonnet', maxTokens: 2000, reason: 'Deep conversation in learning project' };
  }

  // ── Tier 1: Simple structured tasks ──
  for (const p of TIER_1) {
    if (p.test(message)) {
      return { tier: 1, primaryModel: 'gemini-flash', fallbackModel: 'deepseek-chat', maxTokens: 300, reason: 'Simple structured task' };
    }
  }

  // ── Tier 1: Short non-question ──
  if (message.split(/\s+/).length < 8 && !message.includes('?')) {
    return { tier: 1, primaryModel: 'gemini-flash', fallbackModel: 'deepseek-chat', maxTokens: 300, reason: 'Short command' };
  }

  // ── Tier 2: Default ──
  // DeepSeek as primary (cheapest capable), Sonnet as fallback (most reliable)
  return { tier: 2, primaryModel: 'deepseek-chat', fallbackModel: 'sonnet', maxTokens: 800, reason: 'Default workhorse' };
}
