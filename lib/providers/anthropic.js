/**
 * Anthropic provider — Claude Messages API.
 *
 * Exports a single `call({ config, apiKey, system, messages, maxTokens, signal })`.
 * Returns normalised: { text, usage, model, provider, cached }.
 */

import { throwHttpError } from './_shared.js';

/**
 * @param {object} args
 * @param {object} args.config   - MODELS[modelKey] entry
 * @param {string} args.apiKey
 * @param {string} [args.system]
 * @param {Array<{role:string,content:string}>} args.messages
 * @param {number} args.maxTokens
 * @param {AbortSignal} [args.signal]
 */
export async function call({ config, apiKey, system, messages, maxTokens, signal }) {
  const body = {
    model:      config.model,
    max_tokens: maxTokens,
    messages,
  };

  // Prompt caching: mark system prompt as cacheable.
  // Cached tokens cost 10% of normal input rate = 90% savings on repeated calls.
  if (system) {
    body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':    'prompt-caching-2024-07-31',
    },
    body:   JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(120_000),   // Opus can be slow
  });

  if (!res.ok) await throwHttpError('Anthropic', res);

  const data  = await res.json();
  const usage = data.usage ?? {};
  return {
    text:     data.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || '',
    usage: {
      input_tokens:         usage.input_tokens ?? 0,
      output_tokens:        usage.output_tokens ?? 0,
      cached_input_tokens:  usage.cache_read_input_tokens ?? 0,
    },
    model:    config.model,
    provider: 'anthropic',
    cached:   (usage.cache_read_input_tokens ?? 0) > 0,
  };
}
