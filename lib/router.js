/**
 * AI Message Router — classifies incoming inbox items and routes to a project.
 *
 * Three-pass approach:
 *   0. Document heuristic — long pasted text with academic markers → school
 *   1. Keyword match      — free, instant, ~95% confidence
 *   2. Gemini Flash-Lite  — AI classification for ambiguous cases (~$0 free tier)
 *      Falls back to DeepSeek if Gemini quota exhausted.
 */

import { callModelWithFallback } from './multiModelClient.js';
import { logCost }               from './costTracker.js';
import { PROJECTS }              from './projects.js';

const ROUTER_SYSTEM = `You are a routing assistant. Classify the user message into exactly one project key.

Return ONLY valid JSON, no other text:
{"project": "<key>", "confidence": 0.0-1.0, "summary": "<one sentence>", "suggested_action": "<what to do next>"}

Classification rules:
- Pasted school document (syllabus, assignment brief, timetable, unit outline): "school"
- Work tasks, professional deadlines, job-related items explicitly for work: "work"
- Fellowship, internship, job applications: "research_apps"
- GitHub/arXiv/HuggingFace URLs, ML/AI papers, coding tutorials to read/learn: "learning_tech"
- Electronics, circuits, Arduino, PCB, microcontrollers: "circuitry"
- Baking, recipes, bread, pastry: "baking"
- Bead work, jewelry, loom, wire wrap: "beadwork"
- Drawing, pastels, painting, sketching: "art"
- Books, philosophy, essays, non-technical reading: "reading"
- Fitness, workouts, gym: "exercise"
- Default for anything ambiguous or tech-adjacent: "learning_tech"

Never use "art" as a default fallback.`;

/**
 * Route an incoming message/URL to a project.
 *
 * @param {string} text
 * @returns {Promise<{project, projectLabel, confidence, summary, suggested_action, is_new_task}>}
 */
export async function route(text) {
  const lower = text.toLowerCase();

  // ── Pass 0: Document heuristic ──────────────────────────────────────────────
  // Long pasted text with academic structure → school (before keyword scan)
  if (
    text.length > 300 &&
    /\b(assessment|weighting|due date|submission|exam date|assignment|unit outline|credit points|learning outcomes)\b/.test(lower)
  ) {
    const p = PROJECTS.find(proj => proj.key === 'school');
    return {
      project:          'school',
      projectLabel:     p?.label ?? 'School',
      confidence:       0.92,
      summary:          'School document — extracting deadlines and assessments',
      suggested_action: 'Extract deadlines and assessments',
      is_new_task:      true,
    };
  }

  // ── Pass 1: Keyword match (no AI, no cost) ──────────────────────────────────
  // Phrases (spaces) match as substrings; single words require word boundaries
  // to prevent "ml" matching "html", "read" matching "already read", etc.
  const kwMatch = (kw) =>
    kw.includes(' ')
      ? lower.includes(kw)
      : new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower);

  for (const p of PROJECTS) {
    if (p.keywords.some(kwMatch)) {
      return {
        project:          p.key,
        projectLabel:     p.label,
        confidence:       0.90,
        summary:          text.slice(0, 80),
        suggested_action: p.key === 'research_apps' ? 'Scrape and extract questions' : 'Add to project',
        is_new_task:      true,
      };
    }
  }

  // ── Pass 2: AI classification (Gemini Flash-Lite, ~$0 on free tier) ─────────
  const projectList = PROJECTS.map(p => `- "${p.key}": ${p.description}`).join('\n');

  try {
    const result = await callModelWithFallback('gemini-flash', 'deepseek-chat', {
      system:    ROUTER_SYSTEM + `\n\nAvailable projects:\n${projectList}`,
      messages:  [{ role: 'user', content: text }],
      maxTokens: 150,
    });

    logCost(result.modelKey, result.usage, { reason: 'routing' }).catch(() => {});

    const parsed  = JSON.parse(result.text.replace(/```json\n?|```/g, '').trim());
    const matched = PROJECTS.find(p => p.key === parsed.project);

    // If AI returns an unknown key, fall back to learning_tech
    const safe = matched ?? PROJECTS.find(p => p.key === 'learning_tech') ?? PROJECTS[0];

    return {
      project:          safe.key,
      projectLabel:     safe.label,
      confidence:       parsed.confidence      ?? 0.7,
      summary:          parsed.summary         ?? text.slice(0, 80),
      suggested_action: parsed.suggested_action ?? 'Add to project',
      is_new_task:      true,
    };
  } catch (err) {
    console.error('[router:route]', err.message);
    return {
      project:          'learning_tech',
      projectLabel:     'Learning & Tech',
      confidence:       0.3,
      summary:          text.slice(0, 80),
      suggested_action: 'Add to project',
      is_new_task:      true,
    };
  }
}
