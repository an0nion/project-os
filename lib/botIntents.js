/**
 * Central intent dispatcher for slack/bot.js.
 *
 * Two public entry points:
 *   - dispatchPending(state, ctx) — routes mid-conversation replies to the
 *     correct mode handler (reminder/learning/correction). Returns true if
 *     the message was handled, false if bot.js should continue to its own
 *     inline pending branches (prefsMode, editMode, recallMore, searchMode,
 *     clarificationMode — these stay in bot.js for this unit).
 *
 *   - (future) dispatchFresh — once all branches are extracted, this will be
 *     the fresh-message intent router. Out of scope for Unit 1a.
 *
 * Keeping this thin: each mode owns its own state machine in lib/botModes/.
 */

import * as reminderMode from './botModes/reminder.js';
import * as learningMode from './botModes/learning.js';
import * as correctionMode from './botModes/correction.js';

/**
 * Dispatch a pending-state reply to the matching mode handler.
 * Returns true if a mode handled the message, false otherwise.
 *
 * Mode precedence matches the original bot.js if-chain order:
 *   correctionMode → reminderMode → learningMode
 */
export async function dispatchPending(state, ctx) {
  if (state.correctionMode) {
    await correctionMode.handle(state, ctx);
    return true;
  }
  if (state.reminderMode) {
    await reminderMode.handle(state, ctx);
    return true;
  }
  if (state.learningMode) {
    await learningMode.handle(state, ctx);
    return true;
  }
  return false;
}

export { reminderMode, learningMode, correctionMode };
