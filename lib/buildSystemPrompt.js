/**
 * System Prompt Builder
 *
 * Structures prompts for maximum cache hits on Anthropic models.
 * Static content (profile, project config, rules) goes FIRST — gets cached.
 * Dynamic content (tasks, active context) goes LAST — not cached.
 *
 * Cached tokens cost 10% of normal input rate = 90% savings after first call.
 */

/**
 * Build a structured system prompt optimised for prompt caching.
 *
 * @param {object} projectDef  - Entry from lib/projects.js (has .system_prompt)
 * @param {object|null} profile - User profile from Supabase
 * @param {Array} tasks        - Open tasks for the project
 * @param {string} [dynamicContext] - Any time-sensitive context (question details, etc.)
 * @returns {string}
 */
export function buildSystemPrompt(projectDef, profile, tasks, dynamicContext = '') {
  // ── STATIC BLOCK (gets cached) ────────────────────────────────────────────
  // This text stays identical across messages in a session → 90% savings
  let staticBlock = projectDef?.system_prompt ?? 'You are a helpful assistant.';

  if (profile && Object.keys(profile).length > 0) {
    staticBlock += `\n\n=== USER PROFILE ===\n${JSON.stringify(profile, null, 2)}`;
  }

  staticBlock += `\n\n=== RESPONSE RULES ===
- Be direct, no filler, no corporate speak
- Match the user's energy and depth
- When drafting, separate the draft clearly with --- markers`;

  // ── DYNAMIC BLOCK (not cached — changes often) ────────────────────────────
  let dynamicBlock = '';

  if (tasks && tasks.length > 0) {
    dynamicBlock += `\n\nOpen tasks:\n${tasks.slice(0, 15).map(t => `- [${t.status}] ${t.text}`).join('\n')}`;
  }

  if (dynamicContext) {
    dynamicBlock += `\n\n${dynamicContext}`;
  }

  return staticBlock + dynamicBlock;
}
