/**
 * Soft-delete-aware query helper.
 *
 * Wraps a supabase client so SELECT queries always exclude rows where
 * `deleted_at is not null`. Pass `{ includeDeleted: true }` to bypass.
 *
 * The default client is built lazily (not at module-load time) so unit tests
 * can import this module and inject a mock via `opts.client` without needing
 * SUPABASE_URL/SUPABASE_KEY to be set.
 *
 * Usage:
 *   const { data, error } = await selectFrom('items', { columns: '*' })
 *     .eq('project_key', 'inbox')
 *     .order('position');
 *
 *   const { data } = await selectFrom('items', { includeDeleted: true });
 *
 *   const { data } = await selectFrom('items', { client: supabaseAdmin() });
 */

import { createClient } from '@supabase/supabase-js';

let _defaultClient = null;
function getDefaultClient() {
  if (!_defaultClient) {
    _defaultClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  }
  return _defaultClient;
}

/**
 * Build a SELECT query builder that excludes soft-deleted rows by default.
 *
 * @param {string} table
 * @param {object} [opts]
 * @param {string} [opts.columns='*']         — column list passed to .select()
 * @param {object} [opts.selectOptions]       — second arg to .select() (e.g. { count: 'exact' })
 * @param {boolean} [opts.includeDeleted=false] — when true, do NOT filter out deleted rows
 * @param {object} [opts.client]              — custom supabase client
 * @returns {object} Supabase query builder — chainable with .eq, .order, .limit, etc.
 */
export function selectFrom(table, opts = {}) {
  const { columns = '*', selectOptions, includeDeleted = false } = opts;
  const client = opts.client ?? getDefaultClient();

  let q = selectOptions
    ? client.from(table).select(columns, selectOptions)
    : client.from(table).select(columns);

  if (!includeDeleted) q = q.is('deleted_at', null);
  return q;
}

/**
 * Soft-delete: set deleted_at = now() instead of issuing a real DELETE.
 * Returns the Supabase update builder (chain `.eq('id', x)` etc., then await).
 *
 * @param {string} table
 * @param {object} [opts]
 * @param {object} [opts.client] — custom supabase client
 * @returns {object} Supabase update builder
 */
export function softDelete(table, opts = {}) {
  const client = opts.client ?? getDefaultClient();
  return client.from(table).update({ deleted_at: new Date().toISOString() });
}
