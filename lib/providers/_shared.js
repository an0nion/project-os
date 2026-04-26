/**
 * Shared helpers for provider modules.
 */

/**
 * Read the response body as text and throw a normalised error with status attached.
 * @param {string} providerLabel  - "Anthropic", "Google", "DeepSeek"
 * @param {Response} res
 */
export async function throwHttpError(providerLabel, res) {
  const errText = await res.text();
  const e = new Error(`${providerLabel} ${res.status}: ${errText.slice(0, 200)}`);
  e.status = res.status;
  throw e;
}
