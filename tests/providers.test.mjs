/**
 * Provider tests — mock global fetch and verify the normalised shape.
 *
 * Run: node --test tests/providers.test.mjs
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { call as callAnthropic } from '../lib/providers/anthropic.js';
import { call as callGoogle }    from '../lib/providers/google.js';
import { call as callDeepSeek }  from '../lib/providers/deepseek.js';

const ORIG_FETCH = globalThis.fetch;

function mockFetchOk(jsonBody) {
  globalThis.fetch = async () => ({
    ok:    true,
    status: 200,
    json:  async () => jsonBody,
    text:  async () => JSON.stringify(jsonBody),
  });
}

function mockFetchError(status, text) {
  globalThis.fetch = async () => ({
    ok:     false,
    status,
    json:   async () => ({ error: text }),
    text:   async () => text,
  });
}

afterEach(() => { globalThis.fetch = ORIG_FETCH; });

const baseMessages = [{ role: 'user', content: 'hello' }];

// ── Anthropic ───────────────────────────────────────────────────────────────

describe('providers.anthropic', () => {
  test('normalises a successful response', async () => {
    mockFetchOk({
      content: [
        { type: 'text', text: 'hi back' },
        { type: 'text', text: 'second part' },
      ],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4 },
    });
    const r = await callAnthropic({
      config:    { model: 'claude-sonnet-4-20250514' },
      apiKey:    'sk-test',
      system:    'sys',
      messages:  baseMessages,
      maxTokens: 100,
    });
    assert.equal(r.text, 'hi back\nsecond part');
    assert.equal(r.provider, 'anthropic');
    assert.equal(r.model, 'claude-sonnet-4-20250514');
    assert.equal(r.cached, true);
    assert.equal(r.usage.input_tokens, 10);
    assert.equal(r.usage.output_tokens, 5);
    assert.equal(r.usage.cached_input_tokens, 4);
  });

  test('throws with status metadata on HTTP error', async () => {
    mockFetchError(500, 'internal');
    await assert.rejects(
      () => callAnthropic({
        config: { model: 'x' }, apiKey: 'k', messages: baseMessages, maxTokens: 10,
      }),
      err => err.status === 500 && /Anthropic 500/.test(err.message),
    );
  });
});

// ── Google ──────────────────────────────────────────────────────────────────

describe('providers.google', () => {
  test('normalises a successful response', async () => {
    mockFetchOk({
      candidates: [{ content: { parts: [{ text: 'hello' }, { text: 'world' }] } }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
    });
    const r = await callGoogle({
      config:    { model: 'gemini-2.0-flash-lite' },
      apiKey:    'g-test',
      system:    'sys',
      messages:  baseMessages,
      maxTokens: 50,
    });
    assert.equal(r.text, 'hello\nworld');
    assert.equal(r.provider, 'google');
    assert.equal(r.model, 'gemini-2.0-flash-lite');
    assert.equal(r.cached, false);
    assert.equal(r.usage.input_tokens, 7);
    assert.equal(r.usage.output_tokens, 3);
  });

  test('throws with status metadata on HTTP error', async () => {
    mockFetchError(429, 'quota exhausted');
    await assert.rejects(
      () => callGoogle({
        config: { model: 'x' }, apiKey: 'k', messages: baseMessages, maxTokens: 10,
      }),
      err => err.status === 429 && /Google 429/.test(err.message),
    );
  });
});

// ── DeepSeek ────────────────────────────────────────────────────────────────

describe('providers.deepseek', () => {
  test('normalises a successful response', async () => {
    mockFetchOk({
      choices: [{ message: { content: 'pong' } }],
      usage: { prompt_tokens: 4, completion_tokens: 2, prompt_cache_hit_tokens: 1 },
    });
    const r = await callDeepSeek({
      config:    { model: 'deepseek-chat' },
      apiKey:    'ds-test',
      system:    'sys',
      messages:  baseMessages,
      maxTokens: 50,
    });
    assert.equal(r.text, 'pong');
    assert.equal(r.provider, 'deepseek');
    assert.equal(r.model, 'deepseek-chat');
    assert.equal(r.cached, true);
    assert.equal(r.usage.input_tokens, 4);
    assert.equal(r.usage.output_tokens, 2);
    assert.equal(r.usage.cached_input_tokens, 1);
  });

  test('throws with status metadata on HTTP error', async () => {
    mockFetchError(401, 'bad key');
    await assert.rejects(
      () => callDeepSeek({
        config: { model: 'x' }, apiKey: 'k', messages: baseMessages, maxTokens: 10,
      }),
      err => err.status === 401 && /DeepSeek 401/.test(err.message),
    );
  });
});
