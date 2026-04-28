/**
 * Minimal structured logger — emits one JSON line per call.
 *
 * Replaces ad-hoc `console.warn('[mod] ...')` calls.
 * Format: { ts, level, mod, event, ...data }
 *
 *   log.info('inbox', 'received', { source: 'slack' })
 *   log.warn('cron',  'slack_nudge_failed', { err: e.message })
 *   log.error('chat', 'model_error', { err: e.message, stack: e.stack })
 */

function emit(level, mod, event, data) {
  const line = { ts: new Date().toISOString(), level, mod, event };
  if (data && typeof data === 'object') Object.assign(line, data);
  // Use the matching console method so dev-tools and Vercel logs colour them.
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(JSON.stringify(line));
}

export const log = {
  info:  (mod, event, data) => emit('info',  mod, event, data),
  warn:  (mod, event, data) => emit('warn',  mod, event, data),
  error: (mod, event, data) => emit('error', mod, event, data),
};
