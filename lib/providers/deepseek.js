/**
 * DeepSeek provider — OpenAI-compatible chat completions.
 *
 * Exports a single `call({ config, apiKey, system, messages, maxTokens, signal })`.
 * Returns normalised: { text, usage, model, provider, cached }.
 */

import { throwHttpError } from './_shared.js';

/**
 * @param {object} args
 * @param {object} args.config
 * @param {string} args.apiKey
 * @param {string} [args.system]
 * @param {Array<{role:string,content:string}>} args.messages
 * @param {number} args.maxTokens
 * @param {AbortSignal} [args.signal]
 */
export async function call({ config, apiKey, system, messages, maxTokens, signal }) {
  const dsMessages = [];
  if (system) dsMessages.push({ role: 'system', content: system });
  dsMessages.push(...messages);

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model:       config.model,
      messages:    dsMessages,
      max_tokens:  maxTokens,
      temperature: 0.7,
    }),
    signal: signal ?? AbortSignal.timeout(60_000),
  });

  if (!res.ok) await throwHttpError('DeepSeek', res);

  const data  = await res.json();
  const usage = data.usage ?? {};
  return {
    text:     data.choices?.[0]?.message?.content || '',
    usage: {
      input_tokens:        usage.prompt_tokens     || 0,
      output_tokens:       usage.completion_tokens || 0,
      cached_input_tokens: usage.prompt_cache_hit_tokens || 0,
    },
    model:    config.model,
    provider: 'deepseek',
    cached:   (usage.prompt_cache_hit_tokens ?? 0) > 0,
  };
}
