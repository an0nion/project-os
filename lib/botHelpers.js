/**
 * Pure helpers extracted from slack/bot.js.
 *
 * These functions have NO side effects (no network, no Slack client, no env reads
 * beyond APP_URL for link construction in buildSuccessMessage). They are imported
 * by both slack/bot.js and the test suite — keep them dependency-free and synchronous.
 *
 * If you change behaviour here, expect tests in tests/bot-flow.test.mjs and
 * tests/botHelpers.test.mjs to fail until updated. That is intentional — these
 * helpers shape the user-visible reply format and intent-classification contract.
 */

import { VALID_INTENTS, PROJECT_KEYS } from './intentPrompt.js';

// ── Project → emoji map ───────────────────────────────────────────────────────
// Used by buildSuccessMessage and buildReminderMessage. Exported so tests and
// other UI surfaces (recall, batch delivery) can reuse the same mapping.
export const PROJECT_EMOJI = {
  personal:      '🗓️',
  learning_tech: '📚',
  work:          '💼',
  school:        '🎓',
  research_apps: '🔬',
  baking:        '🍞',
  beadwork:      '📿',
  art:           '🎨',
  reading:       '📖',
  exercise:      '💪',
  circuitry:     '⚡',
};

// ── Minimal success reply ─────────────────────────────────────────────────────
// One line, embedded link, no buttons, no blocks.
// Format: "📚 <url|Title> · 1-2 months"
export function buildSuccessMessage(data, cls) {
  const projectEmoji = PROJECT_EMOJI[data.project] ?? '📁';
  const appUrl = `${process.env.APP_URL}/project/${data.project}`;

  // Clean title: strip newlines, emoji codes, chars that break Slack link syntax
  const rawTitle = data.summary ?? '';
  const cleanTitle = rawTitle
    .replace(/\n|\r/g, ' ')
    .replace(/:[a-z_]+:/g, '')
    .replace(/[<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

  const parts = [];
  if (cleanTitle) parts.push(`<${appUrl}|${cleanTitle}>`);
  if (cls?.timeline) parts.push(cls.timeline);

  return `${projectEmoji} ${parts.join(' · ') || 'saved'}`;
}

// ── Reminder reply format (mirrors the to-do list reminder reply) ─────────────
// Used in tests as the canonical format. Bot uses inline reply() calls today;
// this helper keeps the format in one place for future refactor and test parity.
export function buildReminderMessage(data, cls) {
  const title    = (data.summary ?? 'reminder').slice(0, 60);
  const timeNote = cls?.timeline ? ` · ${cls.timeline}` : '';
  return `🗓️ <${process.env.APP_URL}/project/personal|${title}>${timeNote}`;
}

// ── Build enriched text for routing context ───────────────────────────────────
export function buildEnrichedText(context, timeline, text, url) {
  const parts = [];
  if (context === 'work')     parts.push('[Work]');
  if (context === 'personal') parts.push('[Personal]');
  if (text && text !== url)   parts.push(text.replace(url ?? '', '').trim());
  if (timeline)               parts.push(`— ${timeline}`);
  return parts.filter(Boolean).join(' ');
}

// ── Synchronous regex-only context parser ────────────────────────────────────
// Used as a fast pre-check before falling back to the AI parseContext in
// lib/naturalParser.js. Tests call this directly (no AI), so the regex defines
// the deterministic happy-path contract.
export function parseClarificationContext(text) {
  const t = text.toLowerCase();
  if (/\bwork\b|\bjob\b|\bprofessional\b|\bsprint\b|\bticket\b/i.test(text)) return 'work';
  if (/\bpersonal\b|\bperson\b|\bmine\b|\bme\b|\blearning\b|\bfun\b|\bcurious\b/i.test(text)) return 'personal';
  if (/^w\b/i.test(t.trim())) return 'work';
  if (/^p\b/i.test(t.trim())) return 'personal';
  return null;
}

// ── URL extraction (http/https only — ignore mailto:, tel:, etc.) ─────────────
export function extractUrls(message) {
  const urls = [];
  const urlRegex = /https?:\/\/[^\s<>|]+/g;
  if (message.text) urls.push(...(message.text.match(urlRegex) ?? []));
  if (message.blocks) {
    const walk = els => {
      for (const el of els ?? []) {
        if (el.type === 'link' && el.url?.startsWith('http')) urls.push(el.url);
        if (el.elements) walk(el.elements);
      }
    };
    message.blocks.forEach(b => walk(b.elements));
  }
  if (message.attachments) {
    for (const a of message.attachments) {
      if (a.original_url?.startsWith('http')) urls.push(a.original_url);
      if (a.from_url?.startsWith('http'))     urls.push(a.from_url);
      if (a.title_link?.startsWith('http'))   urls.push(a.title_link);
    }
  }
  return [...new Set(urls)].filter(u =>
    !u.includes('slack.com') && !u.includes('slack-edge.com')
  );
}

// ── Normalise an AI-classified task object ────────────────────────────────────
// Accepts whatever the AI returned and returns a strict, validated shape.
// Unknown intents fall back to 'save'; out-of-range tiers become null; etc.
export function normaliseTask(t) {
  const tier = t.priority_tier;
  return {
    intent:              VALID_INTENTS.includes(t.intent) ? t.intent : 'save',
    title:               typeof t.title === 'string' && t.title.trim() ? t.title.trim() : null,
    timeline:            typeof t.timeline === 'string' && t.timeline.trim() ? t.timeline.trim() : null,
    context:             t.context             ?? null,
    project_hint:        PROJECT_KEYS.includes(t.project_hint) ? t.project_hint : null,
    priority_tier:       (Number.isInteger(tier) && tier >= 1 && tier <= 4) ? tier : null,
    needs_clarification: t.needs_clarification === true,
    corrected_project:   t.corrected_project   ?? null,
    recall_topic:        typeof t.recall_topic === 'string' && t.recall_topic.trim() ? t.recall_topic.trim() : null,
    search_query:        typeof t.search_query === 'string' && t.search_query.trim() ? t.search_query.trim() : null,
  };
}
