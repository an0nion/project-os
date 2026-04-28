/**
 * Next.js boot hook — called once per server start.
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * In production: validates env strictly; throws (kills the boot) on bad config.
 * In development: schema is permissive — missing keys log a warning only.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateEnv } = await import('./lib/envSchema.js');
    validateEnv({ context: 'web' });
  }
}
