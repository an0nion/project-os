/**
 * TTL-based message deduplicator.
 *
 * Socket Mode reconnects can replay the same Slack event. This guards against
 * processing the same message.client_msg_id (or event.ts) more than once.
 *
 * Uses an insertion-ordered Map so pruning expired entries is O(N expired),
 * not O(N total). Duplicates from reconnects arrive within seconds, so a 90s
 * TTL catches all real duplicates without holding memory for long.
 */

export class Deduplicator {
  #seen   = new Map();  // key → expiresAtMs
  #maxSize;
  #ttlMs;

  constructor({ maxSize = 200, ttlSeconds = 90 } = {}) {
    this.#maxSize = maxSize;
    this.#ttlMs   = ttlSeconds * 1000;
  }

  /**
   * Returns true if this key has been seen within the TTL window.
   * Registers the key if it has not been seen.
   */
  isDuplicate(key) {
    if (!key) return false;

    const now = Date.now();
    this.#prune(now);

    if (this.#seen.has(key)) return true;

    // Evict oldest entry if at capacity
    if (this.#seen.size >= this.#maxSize) {
      this.#seen.delete(this.#seen.keys().next().value);
    }

    this.#seen.set(key, now + this.#ttlMs);
    return false;
  }

  // Prune expired entries from the front of the Map (insertion order)
  #prune(now) {
    for (const [key, exp] of this.#seen) {
      if (exp <= now) this.#seen.delete(key);
      else break;  // Map is insertion-ordered; once we hit a live entry, stop
    }
  }
}
