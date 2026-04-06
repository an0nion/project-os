/**
 * User-Pasted Question Parser
 *
 * When scraping fails, the user pastes raw text into chat.
 * This module turns that raw text into structured question objects.
 *
 * Two passes:
 *   1. parseQuestions()    — regex/heuristic, free, instant
 *   2. aiParseQuestions()  — Claude fallback, ~$0.005/call
 */

import { chat, parseJson } from '../lib/claude.js';
import { categorize } from '../lib/categories.js';

// ── Simple heuristic parser ───────────────────────────────────────────────────

/**
 * Parse user-pasted text into individual question objects.
 * Handles: numbered lists, bullet lists, newline-separated, question-mark splits.
 *
 * @param {string} rawText
 * @returns {Array<{id, text, category, answer, status}>}
 */
export function parseQuestions(rawText) {
  const text = rawText.trim();
  if (!text) return [];

  let lines = [];

  // Strategy A: numbered / bulleted list
  const listPattern = /^[\s]*(?:\d+[\.\)]\s*|[-•*]\s*|[a-z][\.\)]\s*)/m;
  if (listPattern.test(text)) {
    lines = text
      .split(/\n/)
      .map(l => l.replace(/^[\s]*(?:\d+[\.\)]\s*|[-•*]\s*|[a-z][\.\)]\s*)/, '').trim())
      .filter(l => l.length > 5);
  }

  // Strategy B: newline-separated (each line is a question)
  if (lines.length === 0) {
    const newlineSplit = text.split(/\n+/).map(l => l.trim()).filter(l => l.length > 10);
    if (newlineSplit.length >= 2) lines = newlineSplit;
  }

  // Strategy C: paragraph with question marks
  if (lines.length <= 1) {
    const qSplit = text
      .split(/\?/)
      .map(l => l.trim())
      .filter(l => l.length > 10)
      .map(l => l + '?');
    if (qSplit.length >= 2) lines = qSplit;
  }

  // Strategy D: sentence boundaries (capital letter after punctuation)
  if (lines.length <= 1) {
    const sentenceSplit = text
      .split(/(?<=[.!?])\s+(?=[A-Z])/)
      .filter(l => l.trim().length > 15);
    if (sentenceSplit.length >= 2) lines = sentenceSplit;
  }

  // Fallback: treat entire input as one question
  if (lines.length === 0) lines = [text];

  return lines.map(line => ({
    id:       Math.random().toString(36).slice(2, 9),
    text:     line.trim(),
    category: categorize(line),
    answer:   '',
    status:   'pending',
  }));
}

// ── AI-powered parser (fallback) ─────────────────────────────────────────────

/**
 * Use Claude to parse ambiguous or complex pasted text.
 * Costs ~$0.005 per call. Only invoke when the simple parser produces <= 1 result.
 *
 * @param {string} rawText
 * @returns {Promise<Array<{id, text, category, answer, status}>>}
 */
export async function aiParseQuestions(rawText) {
  const reply = await chat({
    system: `Extract individual application questions from the user's pasted text.
The user copied this from a fellowship or research application form.
Return ONLY a JSON array: [{"text": "the question", "category": "slug"}]
Categories: research_interests, research_statement, motivation, methodology,
publications, collaboration, future_directions, technical_skills, background,
diversity_statement, travel_logistics, availability, other.
Do NOT include simple form fields (name, email, phone, resume upload).
Only include substantive questions that need written answers.`,
    messages: [{ role: 'user', content: rawText }],
    maxTokens: 2000,
  });

  try {
    const questions = parseJson(reply);
    return questions.map(q => ({
      ...q,
      id:     Math.random().toString(36).slice(2, 9),
      answer: '',
      status: 'pending',
    }));
  } catch {
    return [];
  }
}

/**
 * Smart entry point: try simple parser first; fall back to AI if it yields <= 1 result.
 *
 * @param {string} rawText
 * @param {boolean} [forceAi=false]
 */
export async function smartParseQuestions(rawText, forceAi = false) {
  if (forceAi) return aiParseQuestions(rawText);

  const simple = parseQuestions(rawText);
  if (simple.length > 1) return simple;

  // Simple parser gave 0-1 results — escalate to AI
  return aiParseQuestions(rawText);
}
