/**
 * Bot entry point: validates env BEFORE any module that touches process.env
 * is loaded. Runs as `npm run slack`.
 *
 * Why this file exists: ESM `import` statements are hoisted, so we can't put
 * imperative validation code before imports in `bot.js`. Modules like
 * `lib/supabase.js` construct their client at import time and crash with a
 * confusing message if SUPABASE_URL is missing — env validation here surfaces
 * the real cause first, with all bad/missing keys listed.
 */

import 'dotenv/config';
import { validateEnv } from '../lib/envSchema.js';

validateEnv({ context: 'bot' });

const { runBot } = await import('./bot.js');
await runBot();
