/**
 * Learning mode handler — extracted from slack/bot.js.
 *
 * Triggered when pending state has `learningMode: true`. The bot earlier asked
 * "what do you want to do — read, implement, understand the theory, or write
 * about it?" and is now parsing an ongoing dialogue about a learning topic.
 *
 * Two-call architecture:
 *   Call 1: classify reply as "action" or "chat" — tiny JSON, 60 tokens, never truncates
 *   Call 2: if chat, conversational response with full history — plain text, tier-routed
 *
 * History each exchange is stored so Call 2 can answer follow-up questions correctly.
 * Step cap: 8 chat turns before a soft check-in ("want me to save something?").
 *
 * Async batch path: longer drafts go to Anthropic Batch API (50% cost, non-blocking).
 *
 * Pure relocation from bot.js — no behaviour changes.
 */

import { buildSuccessMessage } from '../botHelpers.js';

// ── Build a clean, action-led Kanban title from the learning dialogue ────────
// Format: "Implement linear probes for AI alignment" — sentence-case, natural English.
// Strips "I want to learn about / I want to" from the original topic.
// Passed as forcedTitle to /api/inbox so the AI title extractor is bypassed.
function buildLearningTitle(action, topic) {
  const topicSlug = topic
    .replace(/^i (want to learn about|want to understand|am learning about|want to)\s*/i, '')
    .replace(/^(learn about|tell me about|explain|what is|what are)\s*/i, '')
    .trim();
  const verb = action
    .replace(/\s+(it|the paper|more|about it|everything)$/i, '')
    .trim() || 'Explore';
  const title = `${verb.charAt(0).toUpperCase() + verb.slice(1)}${topicSlug ? ` ${topicSlug}` : ''}`;
  return title.slice(0, 80);
}

export async function handle(state, ctx) {
  const {
    userText, userId, message, say, reply,
    pending, setLastSaved,
    callInbox, callModelWithFallback, logCostViaApi,
    parseSoftCheckInReply, classifyTier, compressHistory,
    processNextDeferred,
  } = ctx;

  const step    = state.step ?? 1;
  const history = state.history ?? [];
  let saveAsText = null;
  let chatReply  = null;

  // ── Soft check-in response: user replied to "shall I save?" prompt ─────
  if (state.softCheckIn) {
    const softReply = await parseSoftCheckInReply(userText);
    if (softReply === 'decline') {
      // Reset step to 5 so the next 3 turns allow chat before triggering check-in again at step=8
      pending.set(userId, { ...state, softCheckIn: false, step: 5 });
      await say(`all good — keep going`);
      return;
    }
    // User said what to save (or anything non-negative) — save it
    pending.delete(userId);
    const saveText = userText.trim().slice(0, 60) || `Explore ${state.originalText.slice(0, 60)}`;
    const title    = buildLearningTitle(saveText, state.originalText);
    const enriched = `${saveText} — ${state.originalText.slice(0, 120)}`;
    try {
      const data = await callInbox({ text: enriched, title, source: 'slack', project: 'learning_tech' });
      if (data.logId) setLastSaved(userId, { logId: data.logId, project: data.project, title: data.summary });
      await reply(message.channel, buildSuccessMessage(data, {}));
      await processNextDeferred(userId, message.channel, say, state.deferredQueue);
    } catch (err) {
      console.error('[bot:learningMode:softCheckInSave]', err.message);
      await say("couldn't save that");
    }
    return;
  }

  // ── Call 1: classify only — tiny JSON, never truncates ─────────────────
  let classifyType = null;
  try {
    const classifyResult = await callModelWithFallback('deepseek-chat', 'gemini-flash', {
      system: `You are classifying a reply in a learning dialogue about: "${state.originalText.slice(0, 150)}"
The user was asked: "what do you want to do — read, implement, understand the theory, or write about it?"

Return ONLY valid JSON, nothing else: {"type": "action"} or {"type": "chat"}

type=action: reply is a short unambiguous task commitment. Examples:
  "implement it" → action  |  "read the paper" → action  |  "write a summary" → action
type=chat: everything else — user wants more info, is exploring, asking questions, or hasn't decided. When in doubt: chat.`,
      messages: [{ role: 'user', content: userText }],
      maxTokens: 60,
    });
    logCostViaApi(classifyResult.modelKey, classifyResult.usage, 'learning_classify');
    const raw    = classifyResult.text?.trim() ?? '';
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim());
    classifyType = parsed?.type ?? null;
  } catch (err) {
    console.error('[learningMode] classify call failed:', err.message);
  }

  let tier = null;

  // ── Decide based on classification ────────────────────────────────────
  if (classifyType === 'action') {
    // Async batch path: longer drafts go to Anthropic Batch API (50% cost, non-blocking)
    const isDraft = /\b(draft|write|outline|summarize|study.?plan|write.?up)\b/i.test(userText);
    if (isDraft && process.env.APP_URL) {
      try {
        await fetch(`${process.env.APP_URL}/api/batch/submit`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-secret': process.env.APP_SECRET },
          body:    JSON.stringify({
            jobs: [{
              system:    `You are a knowledgeable research companion. The user has been exploring: "${state.originalText.slice(0, 150)}". Write a thorough, well-structured response to their request. Use headers and bullet points where appropriate. Be specific and actionable.`,
              messages:  [...history, { role: 'user', content: userText }],
              maxTokens: 2000,
            }],
            projectKey:      'learning_tech',
            deliveryUserId:  userId,
            deliveryChannel: message.channel,
          }),
        });
        pending.delete(userId);
        await say(`on it — I'll send you the draft shortly ✦`);
        return;
      } catch (err) {
        console.error('[learningMode] batch submit failed, falling back:', err.message);
        // Fall through to synchronous save path
      }
    }
    saveAsText = userText.trim().slice(0, 60);

  } else if (classifyType === 'chat' && step < 8) {
    // ── Call 2: conversational response — tier-routed for depth ──────────
    tier = classifyTier(userText, {
      projectKey:  'learning_tech',
      messageCount: step,
      isEscalated:  state.isEscalated ?? false,
    });
    if (tier.tier === 3) console.log(`[bot:learningMode] Tier 3 — ${tier.reason}`);

    // Compress history before Tier 3 (Opus) calls to cap input cost
    const rawHistory = [...history, { role: 'user', content: userText }];
    const callHistory = tier.tier === 3
      ? await compressHistory(rawHistory)
      : rawHistory;

    try {
      const explainResult = await callModelWithFallback(tier.primaryModel, tier.fallbackModel, {
        system: `You are a knowledgeable research companion in an ongoing Slack conversation.
Topic the user is exploring: "${state.originalText.slice(0, 150)}"

Rules:
- Do NOT re-introduce or define the topic from scratch — respond directly to what the user just said.
- Match length to the user's question: short exploratory question → 2-3 sentences max. Detailed technical question → up to 5-6 sentences. Default to shorter.
- Be specific: cite real papers, researchers, findings by name when you know them. Mention them naturally, not as a list.
- Write like a colleague: no "Great question!", no textbook openers, no bullet points, no headers.
- End with a specific observation or question that opens the next line of inquiry. Not a menu of options.
- Plain text only.`,
        messages: callHistory,
        maxTokens: tier.maxTokens,
      });
      logCostViaApi(explainResult.modelKey, explainResult.usage, 'learning_explain');
      chatReply = explainResult.text?.trim() ?? null;
    } catch (err) {
      console.error('[learningMode] explain call failed:', err.message);
    }

  } else if (classifyType === 'chat' && step >= 8) {
    // Soft check-in: 8 turns is a solid conversation — offer to save without forcing
    const shortTopic = state.originalText.slice(0, 60);
    pending.set(userId, { ...state, softCheckIn: true });
    await say(`We've been deep in ${shortTopic} for a while — want me to save something specific to your Learning board so you can come back to it? If so, just say what you'd like to capture.`);
    return;

  } else if (classifyType === null && step >= 3) {
    // AI failed multiple times — save generic rather than loop forever
    saveAsText = `Explore and learn about ${state.originalText.slice(0, 60)}`;
  }

  if (chatReply) {
    const newHistory = [
      ...history,
      { role: 'user', content: userText },
      { role: 'assistant', content: chatReply },
    ];
    const nowEscalated = (tier?.tier ?? 0) === 3;
    pending.set(userId, { ...state, step: step + 1, history: newHistory, isEscalated: nowEscalated }, 14400);
    await say(chatReply);
    return;
  }

  if (!saveAsText) {
    pending.set(userId, { ...state, step: step + 1 });
    await say(`what do you want to do with this — read, implement something, understand the theory, or write about it?`);
    return;
  }

  // Save the clean task
  pending.delete(userId);
  const title    = buildLearningTitle(saveAsText, state.originalText);
  const enriched = `${saveAsText} — ${state.originalText.slice(0, 120)}`;
  try {
    const data = await callInbox({ text: enriched, title, source: 'slack', project: 'learning_tech' });
    if (data.logId) setLastSaved(userId, { logId: data.logId, project: data.project, title: data.summary });
    await reply(message.channel, buildSuccessMessage(data, {}));
    await processNextDeferred(userId, message.channel, say, state.deferredQueue);
  } catch (err) {
    console.error('[bot:learningMode:finalSave]', err.message);
    await say("couldn't save that");
  }
}
