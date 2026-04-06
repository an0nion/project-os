/**
 * Thin wrapper around the Anthropic Messages API.
 * Keeps all model configuration in one place.
 *
 * Cost control note: every call here uses the Anthropic API (~$5/month
 * at typical fellowship-app volume). Keep prompts tight.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const API_VERSION = '2023-06-01';

/**
 * Send a messages request to Claude.
 *
 * @param {object} opts
 * @param {string} opts.system  - System prompt
 * @param {Array}  opts.messages - [{role, content}]
 * @param {number} [opts.maxTokens=2000]
 * @param {string} [opts.model]
 * @returns {Promise<string>} - The assistant's reply text
 */
export async function chat({ system, messages, maxTokens = 2000, model = DEFAULT_MODEL }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content?.find(b => b.type === 'text')?.text ?? '';
}

/**
 * Parse JSON from a Claude response, stripping markdown fences if present.
 */
export function parseJson(text) {
  const cleaned = text.replace(/```json\n?|```/g, '').trim();
  return JSON.parse(cleaned);
}
