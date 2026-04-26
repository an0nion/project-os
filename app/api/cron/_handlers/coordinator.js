/**
 * Cron coordinator — pure async function. Importing this file does NOT
 * import the real handler modules (which would side-effect-init the Slack
 * Bolt App and the Supabase client). The route module imports the registry
 * and passes it explicitly; tests pass mock handlers.
 *
 * Runs every handler with `Promise.allSettled` so one failure cannot abort
 * the others. Returns a per-handler result map and an `ok` flag (true if
 * any handler succeeded).
 */

export const HANDLER_NAMES = [
  'deadlines',
  'costDigest',
  'briefing',
  'dedupCleanup',
  'calendarBackfill',
];

export async function runCoordinator(db, handlers) {
  const settled = await Promise.allSettled(handlers.map(([, mod]) => mod.run(db)));

  const results = {};
  let anySucceeded = false;

  settled.forEach((s, i) => {
    const [key] = handlers[i];
    if (s.status === 'fulfilled') {
      anySucceeded = true;
      const summary = s.value?.summary ?? 'ok';
      results[key]  = `ok: ${summary}`;
      console.log(`[daily-cron] ${key} → ok: ${summary}`);
    } else {
      const msg = s.reason?.message ?? String(s.reason);
      results[key] = `failed: ${msg}`;
      console.error(`[daily-cron] ${key} → failed: ${msg}`);
    }
  });

  return { ok: anySucceeded, results };
}
