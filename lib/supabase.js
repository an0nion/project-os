import { createClient } from '@supabase/supabase-js';

// Anon client — safe in server route handlers (RLS disabled per schema.sql)
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

// Service-role client — bypasses RLS, server-side only
export function supabaseAdmin() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
  );
}

// ── Project-level chat messages ───────────────────────────────────────────────

/**
 * Fetch recent messages for a project.
 * @param {string} projectKey
 * @param {number} limit
 * @returns {Promise<Array<{role, content, metadata}>>}
 */
export async function getMessages(projectKey, limit = 50) {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content, metadata')
    .eq('project_key', projectKey)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

/**
 * Append a message to the project's chat history.
 * @param {string} projectKey
 * @param {'user'|'assistant'|'system'} role
 * @param {string} content
 * @param {object} [metadata] - tier, model, provider, cached, usage
 */
export async function addMessage(projectKey, role, content, metadata = null) {
  const { error } = await supabase
    .from('messages')
    .insert({ project_key: projectKey, role, content, metadata });
  if (error) throw error;
}

// ── User profile ──────────────────────────────────────────────────────────────

/**
 * Fetch the user's profile (interests, bio, etc.) from the profile table.
 * Returns null if not set yet.
 */
export async function getProfile() {
  const { data } = await supabase
    .from('profile')
    .select('data')
    .limit(1)
    .single();
  return data?.data ?? null;
}

// ── Tasks (questions) for a project ──────────────────────────────────────────

/**
 * Fetch open questions/tasks associated with a project's applications.
 * @param {string} projectKey
 * @returns {Promise<Array>}
 */
export async function getTasks(projectKey) {
  const { data } = await supabase
    .from('questions')
    .select('id, text, category, status, answer, applications!inner(project_key)')
    .eq('applications.project_key', projectKey)
    .neq('status', 'final')
    .limit(20);
  return data ?? [];
}
