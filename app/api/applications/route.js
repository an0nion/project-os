/**
 * GET  /api/applications        — list all applications (optional ?project= filter)
 * POST /api/applications        — create application manually (without scraping)
 *
 * Soft-delete-aware: GET hides rows with deleted_at IS NOT NULL via lib/supabaseQuery.js.
 */

import { supabase }              from '../../../lib/supabase.js';
import { selectFrom }            from '../../../lib/supabaseQuery.js';
import { ok, fail }              from '../../../lib/apiResponse.js';
import { ApplicationPost }       from '../../../lib/schemas.js';
import { ValidationError, UpstreamError } from '../../../lib/errors.js';
import { log }                   from '../../../lib/log.js';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const projectKey = searchParams.get('project');

    let query = selectFrom('applications', { columns: '*, questions(*)' })
      .order('deadline', { ascending: true, nullsFirst: false });

    if (projectKey) query = query.eq('project_key', projectKey);

    const { data, error } = await query;
    if (error) throw new UpstreamError(error.message);

    return ok({ applications: data ?? [] });
  } catch (err) {
    log.error('applications', 'get_failed', { err: err.message });
    return fail(err);
  }
}

export async function POST(req) {
  try {
    let body;
    try { body = await req.json(); }
    catch { throw new ValidationError('Invalid JSON'); }

    const parsed = ApplicationPost.safeParse(body);
    if (!parsed.success) throw new ValidationError('Bad request', parsed.error.format());

    const { name, org, url, deadline, projectKey } = parsed.data;

    const { data, error } = await supabase
      .from('applications')
      .insert({ name, org: org ?? '', url: url ?? null, deadline: deadline ?? null, project_key: projectKey, status: 'backlog' })
      .select()
      .single();

    if (error) throw new UpstreamError(error.message);

    return ok({ application: data }, { status: 201 });
  } catch (err) {
    log.error('applications', 'post_failed', { err: err.message });
    return fail(err);
  }
}
