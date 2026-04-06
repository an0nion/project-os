/**
 * AI Message Router — classifies incoming inbox items and routes to a project.
 *
 * Two-pass approach:
 *   1. Keyword match (free, instant)
 *   2. Claude classification (paid fallback, ~$0.001/call)
 */

import { chat, parseJson } from './claude.js';
import { PROJECTS }        from './projects.js';

/**
 * Route an incoming message/URL to a project.
 *
 * @param {string} text
 * @returns {Promise<{project, projectLabel, confidence, summary, suggested_action, is_new_task}>}
 */
export async function route(text) {
  const lower = text.toLowerCase();

  // Pass 1: keyword match (free)
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

  // Pass 2: Claude classification (fallback)
  const projectList = PROJECTS.map(p => `- "${p.key}": ${p.description}`).join('\n');

  try {
    const reply = await chat({
      system: `You are a routing assistant. Classify the user message into exactly one project.
Projects:
${projectList}

Return ONLY valid JSON:
{"project": "<key>", "confidence": 0.0-1.0, "summary": "<one sentence>", "suggested_action": "<what to do next>"}
If nothing fits, use "art". Never explain.`,
      messages: [{ role: 'user', content: text }],
      maxTokens: 120,
    });

    const result  = parseJson(reply);
    const matched = PROJECTS.find(p => p.key === result.project) ?? PROJECTS[0];

    return {
      project:          matched.key,
      projectLabel:     matched.label,
      confidence:       result.confidence   ?? 0.7,
      summary:          result.summary      ?? text.slice(0, 80),
      suggested_action: result.suggested_action ?? 'Add to project',
      is_new_task:      true,
    };
  } catch {
    // Hard fallback
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
