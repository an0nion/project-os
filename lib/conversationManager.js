/**
 * Rolling Conversation Summary
 *
 * After SUMMARY_AFTER messages, compress older messages into a 150-word summary
 * using a free model. Always keep the KEEP_RECENT most recent messages verbatim.
 *
 * Impact: caps input history at ~1,500 tokens regardless of conversation length.
 * A 40-message Opus session without this sends ~30k tokens per message.
 * With compression: ~1,500 tokens = 20x cheaper input costs.
 */

const SUMMARY_AFTER = 8;   // Summarize when history exceeds this
const KEEP_RECENT   = 3;   // Always keep last N messages verbatim

/**
 * Compress conversation history for the API call.
 * Returns a shorter message array that preserves context.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
export async function compressHistory(messages) {
  if (messages.length <= SUMMARY_AFTER) return messages;

  const toSummarize = messages.slice(0, -KEEP_RECENT);
  const toKeep      = messages.slice(-KEEP_RECENT);

  try {
    // Dynamic import avoids circular dependency (conversationManager ↔ multiModelClient)
    const { callModelWithFallback } = await import('./multiModelClient.js');

    const summary = await callModelWithFallback('gemini-flash', 'deepseek-chat', {
      system:    "Summarize this conversation in under 150 words. Capture: key facts shared, decisions made, current topic, and the user's position/preferences. No commentary.",
      messages:  [{
        role:    'user',
        content: toSummarize.map(m => `${m.role}: ${m.content}`).join('\n'),
      }],
      maxTokens: 200,
    });

    return [
      { role: 'user',      content: `[Conversation so far: ${summary.text}]` },
      { role: 'assistant', content: 'Got it, I have the context.' },
      ...toKeep,
    ];
  } catch {
    // If summarization fails, fall back to sending just recent messages
    return toKeep;
  }
}

// Backward-compat alias
export const manageConversationHistory = compressHistory;
