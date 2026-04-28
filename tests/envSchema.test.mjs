import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateEnv } from '../lib/envSchema.js';

const FULL_PROD_ENV = {
  NODE_ENV:                     'production',
  ANTHROPIC_API_KEY:            'sk-ant-abcdef0123456789abcdef',
  GOOGLE_AI_API_KEY:            'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  DEEPSEEK_API_KEY:             'sk-1234567890abcdef1234567890abcdef',
  SUPABASE_URL:                 'https://abcd.supabase.co',
  SUPABASE_KEY:                 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature_long_enough',
  SUPABASE_SERVICE_KEY:         'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.servicekey_long_enough',
  APP_URL:                      'https://example.com',
  APP_SECRET:                   'a'.repeat(32),
  CRON_SECRET:                  'b'.repeat(32),
  COST_LOG_SECRET:              'c'.repeat(32),
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: 'p'.repeat(88),
  VAPID_PRIVATE_KEY:            'v'.repeat(43),
  VAPID_EMAIL:                  'mailto:ops@example.com',
};

describe('validateEnv', () => {
  test('passes with a complete production env', () => {
    const out = validateEnv({ context: 'web', env: FULL_PROD_ENV });
    assert.equal(out.NODE_ENV, 'production');
    assert.equal(out.APP_TIMEZONE, 'Australia/Melbourne'); // default applied
  });

  test('rejects malformed ANTHROPIC_API_KEY in production', () => {
    const env = { ...FULL_PROD_ENV, ANTHROPIC_API_KEY: 'foo' };
    assert.throws(
      () => validateEnv({ context: 'web', env }),
      /ANTHROPIC_API_KEY.*sk-ant-/s,
    );
  });

  test('rejects multiple bad keys with all issues listed', () => {
    const env = {
      ...FULL_PROD_ENV,
      ANTHROPIC_API_KEY: 'foo',
      GOOGLE_AI_API_KEY: 'bar',
      SUPABASE_URL:      'not-a-url',
    };
    assert.throws(
      () => validateEnv({ context: 'web', env }),
      err => /ANTHROPIC_API_KEY/.test(err.message)
          && /GOOGLE_AI_API_KEY/.test(err.message)
          && /SUPABASE_URL/.test(err.message),
    );
  });

  test('bot context requires Slack tokens in production', () => {
    assert.throws(
      () => validateEnv({ context: 'bot', env: FULL_PROD_ENV }),
      /bot context missing.*SLACK_BOT_TOKEN/s,
    );
  });

  test('bot context passes with Slack + Tavily tokens', () => {
    const env = {
      ...FULL_PROD_ENV,
      SLACK_BOT_TOKEN: 'xoxb-123-456-abc',
      SLACK_APP_TOKEN: 'xapp-1-A123-456-abc',
      SLACK_USER_ID:   'U01ABCDEF',
      TAVILY_API_KEY:  'tvly-abcdef0123456789',
    };
    const out = validateEnv({ context: 'bot', env });
    assert.equal(out.SLACK_BOT_TOKEN, 'xoxb-123-456-abc');
  });

  test('development mode tolerates missing keys (no throw)', () => {
    const env = { NODE_ENV: 'development' };
    // Should not throw — dev mode is permissive.
    const out = validateEnv({ context: 'web', env });
    assert.equal(out.NODE_ENV, 'development');
  });

  test('development mode tolerates malformed-looking keys', () => {
    // In dev, partial schema means optional even when present-but-bad — but
    // we still want types to validate. Bad regex match should still pass
    // because the dev schema makes everything optional.
    const env = { NODE_ENV: 'development', ANTHROPIC_API_KEY: 'sk-ant-tooshort' };
    const out = validateEnv({ context: 'web', env });
    assert.equal(out.NODE_ENV, 'development');
  });

  test('treats unset NODE_ENV as development (permissive)', () => {
    const env = {};
    const out = validateEnv({ context: 'web', env });
    // Schema default is 'production', but isProd() checks raw env.
    // Since env.NODE_ENV is undefined, raw isProd is false → dev schema.
    assert.ok(out !== null);
  });
});
