/**
 * Reminder mode handler — extracted from slack/bot.js.
 *
 * Triggered when pending state has `reminderMode: true`. The bot earlier asked
 * "when is X?" and is now parsing the user's reply.
 *
 * Flow:
 *   - User says "to do" → save to personal Kanban as a to-do (no calendar event)
 *   - User gives a date → parse, create calendar event with prefs
 *   - Unparseable date, first miss → re-ask
 *   - Unparseable date, second miss → fall back to to-do save
 *
 * Pure relocation from bot.js — no behaviour changes. ctx bundles the shared
 * dependencies (slack reply fns, pending store, lastSaved tracker, API and
 * parser fns, calendar helpers).
 */

export async function handle(state, ctx) {
  const {
    userText, userId, message, say, reply,
    pending, setLastSaved,
    callInbox, parseTimelineToDate, parseTodoReply,
    pickColorId, createCalendarEventWithPrefs,
    processNextDeferred,
  } = ctx;

  const isToDoReply = await parseTodoReply(userText);

  if (isToDoReply) {
    // Save to personal Kanban, no calendar
    pending.delete(userId);
    try {
      const data = await callInbox({
        text:    state.reminderTitle,
        title:   state.reminderTitle,
        source:  'slack',
        project: 'personal',
      });
      if (data.logId) setLastSaved(userId, { logId: data.logId, project: data.project, title: state.reminderTitle });
      await reply(message.channel, `🗓️ <${process.env.APP_URL}/project/personal|${state.reminderTitle.slice(0, 60)}> · added to your to-do list`);
      await processNextDeferred(userId, message.channel, say, state.deferredQueue);
    } catch (err) {
      console.error('[bot:reminderMode:todoSave]', err.message);
      await say("couldn't save that");
    }
    return;
  }

  // User gave a date — parse it and route to calendar
  const date = await parseTimelineToDate(userText)
    ?? await parseTimelineToDate(userText.replace(/^(on|at|by|this|next)\s+/i, ''));

  if (!date) {
    // Couldn't parse — re-ask once then save as to-do
    const reask = (state.reminderReask ?? 0) + 1;
    if (reask >= 2) {
      pending.delete(userId);
      try {
        await callInbox({ text: state.reminderTitle, title: state.reminderTitle, source: 'slack', project: 'personal' });
        await reply(message.channel, `🗓️ <${process.env.APP_URL}/project/personal|${state.reminderTitle.slice(0, 60)}> · added to your to-do list`);
        await processNextDeferred(userId, message.channel, say, state.deferredQueue);
      } catch (err) {
        console.error('[bot:reminderMode:reaskSave]', err.message);
        await say("couldn't save that");
      }
      return;
    }
    pending.set(userId, { ...state, reminderReask: reask });
    await say(`didn't catch a date — try "this Saturday", "13th", "in 2 weeks", or say *to do* to add to your list`);
    return;
  }

  // Got a valid date — create calendar event with user preferences
  pending.delete(userId);
  const colorId  = pickColorId('personal', state.originalText);
  let calCreated = false;
  if (process.env.CALENDAR_ENABLED === 'true') {
    try {
      calCreated = await createCalendarEventWithPrefs({
        title:       state.reminderTitle,
        date,
        colorId,
        description: state.originalText,
      });
    } catch (err) {
      console.error('[calendar] event creation failed (network):', err.message);
    }
  }
  await say(`📅 ${state.reminderTitle} · ${userText.trim()}${calCreated ? ' · added to calendar' : ''}`);
  await processNextDeferred(userId, message.channel, say, state.deferredQueue);
}
