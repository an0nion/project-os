/**
 * Google provider — Gemini generateContent API.
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
  const contents = messages.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  signal ?? AbortSignal.timeout(30_000),
  });

  if (!res.ok) await throwHttpError('Google', res);

  const data = await res.json();
  return {
    text:     data.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || '',
    usage: {
      input_tokens:  data.usageMetadata?.promptTokenCount     || 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
    },
    model:    config.model,
    provider: 'google',
    cached:   false,
  };
}
