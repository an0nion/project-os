/**
 * Correction mode handler — extracted from slack/bot.js.
 *
 * Triggered when pending state has `correctionMode: true`. The bot earlier asked
 * "which project should it be in?" and is now parsing the user's reply.
 *
 * Flow:
 *   - User names a valid project → call /api/inbox/correct, confirm, advance queue
 *   - Unrecognised reply, first miss → re-ask with project list
 *   - Unrecognised reply, second miss → give up gracefully ("keeping it as-is")
 *
 * Pure relocation from bot.js — no behaviour changes.
 */

export async function handle(state, ctx) {
  const {
    userText, userId, message, say,
    pending, lastSaved,
    parseProjectKey, callCorrect,
    processNextDeferred,
  } = ctx;

  const proj = await parseProjectKey(userText);

  if (!proj) {
    const reaskCount = (state.correctionStep ?? 0) + 1;
    if (reaskCount >= 2) {
      // Gave up — just confirm it stays where it is
      pending.delete(userId);
      await say(`ok, keeping it as-is`);
      await processNextDeferred(userId, message.channel, say, state.deferredQueue);
      return;
    }
    pending.set(userId, { ...state, correctionStep: reaskCount });
    await say("didn't catch that — try: school, work, learning, research, art, baking, beads, circuits, reading, exercise, personal");
    return;
  }

  pending.delete(userId);
  await callCorrect(state.logId, proj, userText);
  lastSaved.delete(userId);
  await say(`moved to ${proj} ✓`);
  await processNextDeferred(userId, message.channel, say, state.deferredQueue);
}
