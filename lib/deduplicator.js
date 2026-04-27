/**
 * TTL-based message deduplicator — persistent across restarts.
 *
 * Socket Mode reconnects (and bot process restarts) can replay the same Slack
 * event. This guards against processing the same message hash more than once
 * within the TTL window, even if the process restarts mid-window.
 *
 * Architecture:
 *   - In-memory front cache (Map, insertion-ordered) — same-process hits cost
 *     nothing and never touch the database.
 *   - Supabase `dedup_log` table — persists hashes across restarts so a fresh
 *     process can still spot a replayed event from before the crash.
 *
 * The table is written behind the cache: a miss in the cache triggers a
 * SELECT, then an INSERT-if-absent. Cleanup of expired rows is handled by
 * the cron job added in Unit 6 (cron/dedup-cleanup).
 */

import { supabase } from './supabase.js';

export class Deduplicator {
  #seen = new Map();   // hash → expiresAtMs (front cache)
  #maxSize;
  #ttlMs;
  #client;

  constructor({ maxSize = 200, ttlSeconds = 90, client = supabase } = {}) {
    this.#maxSize = maxSize;
    this.#ttlMs   = ttlSeconds * 1000;
    this.#client  = client;
  }

  /**
   * Returns true if `hash` has been seen within the TTL window.
   * Otherwise registers it and returns false.
   *
   * Async because misses round-trip to Supabase.
   */
  async seen(hash) {
    if (!hash) return false;

    const now = Date.now();
    this.#prune(now);

    if (this.#seen.has(hash)) return true;

    let foundInDb = false;
    try {
      const { data } = await this.#client
        .from('dedup_log')
        .select('message_hash')
        .eq('message_hash', hash)
        .gt('expires_at', new Date(now).toISOString())
        .limit(1)
        .maybeSingle();
      foundInDb = !!data;
    } catch (err) {
      // DB unreachable: fall back to in-memory — better a duplicate than
      // dropping every message during a Supabase outage.
      console.error('[deduplicator] select failed:', err.message);
    }

    this.#cacheSet(hash, now);
    if (foundInDb) return true;

    try {
      await this.#client
        .from('dedup_log')
        .insert({
          message_hash: hash,
          expires_at:   new Date(now + this.#ttlMs).toISOString(),
        });
    } catch (err) {
      // PK conflict here means another worker inserted the same hash between
      // our SELECT and INSERT — extremely rare for Slack events; log & proceed.
      console.error('[deduplicator] insert failed:', err.message);
    }
    return false;
  }

  #cacheSet(hash, now) {
    if (this.#seen.size >= this.#maxSize) {
      this.#seen.delete(this.#seen.keys().next().value);
    }
    this.#seen.set(hash, now + this.#ttlMs);
  }

  #prune(now) {
    for (const [key, exp] of this.#seen) {
      if (exp <= now) this.#seen.delete(key);
      else break;  // Map is insertion-ordered; first live entry → stop
    }
  }
}
