/**
 * Write-through pending state store.
 *
 * Previously `pending` was an in-memory Map in bot.js. PM2 restarts erased all
 * mid-conversation state (users mid prefs-setup, reminder flow, etc.).
 *
 * This class has the same Map interface (has/get/set/delete) so no call sites
 * need to change. Reads are always fast in-memory. Writes/deletes mirror to
 * Supabase asynchronously via the Vercel /api/sessions proxy.
 *
 * On startup, call hydrateAll() to restore active sessions from DB.
 */

// TTL values per state type (seconds)
export const TTL = {
  prefsMode:         1800,   // 30 min
  reminderMode:      3600,   // 1 hr
  correctionMode:    3600,
  clarificationMode: 3600,
  searchMode:        3600,
  learningMode:      14400,  // 4 hr — long conversations
  default:           3600,
};

function getTtl(state) {
  for (const key of Object.keys(TTL)) {
    if (key !== 'default' && state[key]) return TTL[key];
  }
  return TTL.default;
}

// Cap history to last 20 turns to avoid JSONB bloat
function sanitiseState(state) {
  if (!Array.isArray(state.history) || state.history.length <= 20) return state;
  return { ...state, history: state.history.slice(-20) };
}

class PendingStore {
  #mem    = new Map();
  #appUrl;
  #secret;

  constructor(appUrl, secret) {
    this.#appUrl = appUrl;
    this.#secret = secret;
  }

  // ── Sync reads — always fast ─────────────────────────────────────────────────

  has(userId) { return this.#mem.has(userId); }
  get(userId) { return this.#mem.get(userId); }

  // ── Write-through ────────────────────────────────────────────────────────────

  /**
   * @param {string} userId
   * @param {object} state
   * @param {number} [ttlSeconds] — defaults to state-type-aware TTL
   */
  set(userId, state, ttlSeconds) {
    this.#mem.set(userId, state);
    const ttl = ttlSeconds ?? getTtl(state);
    this.#persist(userId, state, ttl);
    return this;
  }

  delete(userId) {
    this.#mem.delete(userId);
    this.#remove(userId);
    return true;
  }

  // ── Startup hydration ────────────────────────────────────────────────────────

  async hydrateAll() {
    if (!this.#appUrl || !this.#secret) return;
    try {
      const res = await fetch(`${this.#appUrl}/api/sessions`, {
        headers: { 'x-api-secret': this.#secret },
      });
      if (res.ok) {
        const { sessions } = await res.json();
        for (const { user_id, state } of sessions ?? []) {
          this.#mem.set(user_id, state);
        }
        console.log(`[PendingStore] hydrated ${sessions?.length ?? 0} active session(s)`);
      }
    } catch (err) {
      console.error('[PendingStore:hydrateAll]', err.message);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  #persist(userId, state, ttlSeconds) {
    if (!this.#appUrl || !this.#secret) return;
    const clean = sanitiseState(state);
    fetch(`${this.#appUrl}/api/sessions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': this.#secret },
      body:    JSON.stringify({ userId, state: clean, ttlSeconds }),
    }).catch(err => console.error('[PendingStore:persist]', err.message));
  }

  #remove(userId) {
    if (!this.#appUrl || !this.#secret) return;
    fetch(`${this.#appUrl}/api/sessions?userId=${encodeURIComponent(userId)}`, {
      method:  'DELETE',
      headers: { 'x-api-secret': this.#secret },
    }).catch(err => console.error('[PendingStore:remove]', err.message));
  }
}

export default PendingStore;
