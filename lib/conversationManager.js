/**
 * Rolling Conversation Summary
 *
 * Problem: sending full conversation history on every message balloons input costs.
 * A 40-message session would send ~30k tokens per message by the end.
 *
 * Solution: after SUMMARY_THRESHOLD messages, compress older messages into a
 * 150-word summary using Gemini Flash-Lite (~$0.00001 per summary).
 * We always keep the KEEP_RECENT most recent messages in full.
 *
 * Impact: caps input history at ~1,500 tokens regardless of conversation length.
 * That's a ~20x reduction for long chats.
 */

const SUMMARY_THRESHOLD = 8;  // start compressing after this many messages
const KEEP_RECENT       = 3;  // always keep these in full

/**
 * Return a (possibly compressed) message array safe to send to any model.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<Array<{role: string, content: string}>>}
 */
export async function manageConversationHistory(messages) {
  if (messages.length <= SUMMARY_THRESHOLD) return messages;

  const toSummarize = messages.slice(0, -KEEP_RECENT);
  const toKeep      = messages.slice(-KEEP_RECENT);

  try {
    // Dynamic import avoids circular dependency (conversationManager ↔ multiModelClient)
    const { chatWithModel } = await import('./multiModelClient.js');

    const result = await chatWithModel('gemini-flash-lite', {
      system: 'Summarize this conversation in 150 words or fewer. Capture key decisions, facts shared, and the current direction of discussion. Do not add commentary or greetings.',
      messages: [{
        role:    'user',
        content: toSummarize.map(m => `${m.role}: ${m.content}`).join('\n'),
      }],
      maxTokens: 200,
    });

    return [
      { role: 'user',      content: `[Previous conversation summary: ${result.text}]` },
      { role: 'assistant', content: 'Understood, I have the context from our earlier discussion.' },
      ...toKeep,
    ];
  } catch {
    // If summarization fails, fall back to sending just recent messages
    return toKeep;
  }
}
