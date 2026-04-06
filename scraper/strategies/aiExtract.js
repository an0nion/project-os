/**
 * Strategy 4: Claude reads raw HTML (last resort before manual paste)
 * Costs one API call (~$0.01). Only fires when we have HTML but no
 * extracted questions from the three free strategies.
 */

import { chat, parseJson } from '../../lib/claude.js';

export async function aiExtractFromUrl(url, html) {
  if (!html || html.length < 500) {
    throw new Error('No HTML content to analyze');
  }

  // Keep first 50k chars to stay within context window comfortably
  const truncated = html.slice(0, 50_000);

  const reply = await chat({
    system: `Extract application/fellowship questions from this HTML.
Return ONLY a JSON object with this exact shape:
{
  "org": "organization name",
  "position": "position or fellowship title",
  "deadline": "ISO date string or empty string",
  "questions": [
    { "text": "the question text", "category": "category_slug" }
  ]
}
Categories: research_interests, research_statement, motivation, methodology,
publications, collaboration, future_directions, technical_skills, background,
diversity_statement, travel_logistics, availability, other.
Do NOT include simple form fields (name, email, phone, file uploads).
Only include substantive questions that need written answers.
If you cannot find any questions, return { "error": "no_questions_found" }`,
    messages: [{ role: 'user', content: `URL: ${url}\n\nHTML:\n${truncated}` }],
    maxTokens: 4000,
  });

  const result = parseJson(reply);
  if (result.error) throw new Error(result.error);

  // Attach ids and default answer state
  result.questions = (result.questions ?? []).map(q => ({
    ...q,
    id: Math.random().toString(36).slice(2, 9),
    answer: '',
    status: 'pending',
  }));

  return { ...result, method: 'ai_extract' };
}
