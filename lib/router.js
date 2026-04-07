/**
 * AI Message Router — classifies incoming inbox items and routes to a project.
 *
 * Two-pass approach:
 *   1. Keyword match (free, instant)
 *   2. Gemini Flash-Lite classification (Tier 1 — ~$0 on free tier)
 *      Falls back to DeepSeek if Gemini free quota exhausted.
 */

import { chatWithModel } from './multiModelClient.js';
import { PROJECTS }      from './projects.js';

const ROUTER_SYSTEM = `You are a routing assistant. Classify the user message into exactly one project.
Return ONLY valid JSON (no other text):
{"project": "<key>", "confidence": 0.0-1.0, "summary": "<one sentence>", "suggested_action": "<what to do next>"}
If nothing fits, use "art". Never explain.`;

/**
 * Route an incoming message/URL to a project.
 *
 * @param {string} text
 * @returns {Promise<{project, projectLabel, confidence, summary, suggested_action, is_new_task}>}
 */
export async function route(text) {
  const lower = text.toLowerCase();

  // Pass 1: keyword match (no AI, no cost)
  for (const p of PROJECTS) {
    if (p.keywords.some(kw => lower.includes(kw))) {
      return {
        project:          p.key,
        projectLabel:     p.label,
        confidence:       0.95,
        summary:          text.slice(0, 80),
        suggested_action: p.key === 'research_apps' ? 'Scrape and extract questions' : 'Add to project',
        is_new_task:      true,
      };
    }
  }

  // Pass 2: Tier 1 AI classification (Gemini Flash-Lite, ~$0 on free tier)
  const projectList = PROJECTS.map(p => `- "${p.key}": ${p.description}`).join('\n');

  try {
    const result = await chatWithModel('gemini-flash', {
      system:    ROUTER_SYSTEM + `\n\nProjects:\n${projectList}`,
      messages:  [{ role: 'user', content: text }],
      maxTokens: 150,
    });

    const parsed  = JSON.parse(result.text.replace(/```json\n?|```/g, '').trim());
    const matched = PROJECTS.find(p => p.key === parsed.project) ?? PROJECTS[PROJECTS.length - 1];

    return {
      project:          matched.key,
      projectLabel:     matched.label,
      confidence:       parsed.confidence   ?? 0.7,
      summary:          parsed.summary      ?? text.slice(0, 80),
      suggested_action: parsed.suggested_action ?? 'Add to project',
      is_new_task:      true,
    };
  } catch {
    return {
      project:          'art',
      projectLabel:     'Art & Making',
      confidence:       0.3,
      summary:          text.slice(0, 80),
      suggested_action: 'Add to project',
      is_new_task:      true,
    };
  }
}
