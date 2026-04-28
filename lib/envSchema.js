/**
 * Env validation: refuse to start in production with malformed/missing keys.
 * Single-user codebase, but config drift is the #1 cause of "why isn't it working".
 *
 * Production: strict schema; throws with a human-readable list of issues.
 * Development: same schema, all keys partial; missing values warn but don't throw.
 *
 * Called from `instrumentation.js` (Next.js boot) and `slack/bot.js` (bot boot).
 */

import { z } from 'zod';
import { DEFAULT_APP_TZ } from './timezone.js';

const isProd = () => process.env.NODE_ENV === 'production';

const ProductionEnv = z.object({
  // AI providers
  ANTHROPIC_API_KEY:   z.string().regex(/^sk-ant-/, 'must start with sk-ant-'),
  GOOGLE_AI_API_KEY:   z.string().regex(/^AIza/, 'must start with AIza'),
  DEEPSEEK_API_KEY:    z.string().regex(/^sk-/, 'must start with sk-'),

  // Supabase
  SUPABASE_URL:         z.string().url(),
  SUPABASE_KEY:         z.string().min(40),
  SUPABASE_SERVICE_KEY: z.string().min(40).startsWith('eyJ'),

  // App
  APP_URL:              z.string().url(),
  APP_SECRET:           z.string().min(20),
  CRON_SECRET:          z.string().min(20),
  COST_LOG_SECRET:      z.string().min(20),
  APP_TIMEZONE:         z.string().default(DEFAULT_APP_TZ),
  NODE_ENV:             z.enum(['development', 'test', 'production']).default('production'),

  // Slack (bot context only)
  SLACK_BOT_TOKEN:      z.string().regex(/^xoxb-/).optional(),
  SLACK_APP_TOKEN:      z.string().regex(/^xapp-/).optional(),
  SLACK_USER_ID:        z.string().regex(/^U/).optional(),

  // Calendar (gated)
  GOOGLE_CLIENT_ID:             z.string().endsWith('.apps.googleusercontent.com').optional(),
  GOOGLE_CLIENT_SECRET:         z.string().optional(),
  GOOGLE_CALENDAR_REDIRECT_URI: z.string().url().optional(),
  CALENDAR_ENABLED:             z.enum(['true', 'false']).default('false'),

  // Web push
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().min(80),
  VAPID_PRIVATE_KEY:            z.string().min(40),
  VAPID_EMAIL:                  z.string().regex(/^mailto:/),

  // Tavily (bot only)
  TAVILY_API_KEY:       z.string().regex(/^tvly-/).optional(),
}).passthrough();

const DevelopmentEnv = ProductionEnv.partial();

/**
 * Validate `process.env` against the schema for the given runtime context.
 *
 * @param {object} [opts]
 * @param {'web'|'bot'} [opts.context='web'] — bot context additionally requires Slack tokens in prod.
 * @param {NodeJS.ProcessEnv} [opts.env=process.env] — override for tests.
 * @returns {object} parsed/coerced env values
 * @throws {Error} when validation fails (production) — message lists every issue.
 */
export function validateEnv({ context = 'web', env = process.env } = {}) {
  const prod = env.NODE_ENV === 'production';
  const schema = prod ? ProductionEnv : DevelopmentEnv;
  const result = schema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`[envSchema] env validation failed (context=${context}):\n${issues}`);
  }

  // Bot context: Slack + Tavily tokens are mandatory in production.
  if (context === 'bot' && prod) {
    const required = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_USER_ID', 'TAVILY_API_KEY'];
    const missing = required.filter(k => !env[k]);
    if (missing.length) {
      throw new Error(`[envSchema] bot context missing required vars: ${missing.join(', ')}`);
    }
  }

  // Dev convenience: warn about missing critical keys without throwing.
  if (!prod) {
    const critical = ['ANTHROPIC_API_KEY', 'GOOGLE_AI_API_KEY', 'DEEPSEEK_API_KEY', 'SUPABASE_URL'];
    const missing = critical.filter(k => !env[k]);
    if (missing.length) {
      // eslint-disable-next-line no-console
      console.warn(`[envSchema] dev mode: missing ${missing.join(', ')} (allowed in dev)`);
    }
  }

  return result.data;
}

// Exposed for tests.
export const _internal = { ProductionEnv, DevelopmentEnv };
