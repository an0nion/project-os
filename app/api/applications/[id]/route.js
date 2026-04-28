/**
 * GET    /api/applications/:id  — fetch single application with questions
 * PATCH  /api/applications/:id  — update fields (status, name, org, deadline, etc.)
 * DELETE /api/applications/:id  — soft-delete: sets deleted_at; trigger
 *                                 propagates to child questions (audit-safe).
 */

import { supabase }              from '../../../../lib/supabase.js';
import { selectFrom, softDelete } from '../../../../lib/supabaseQuery.js';
import { ok, fail }              from '../../../../lib/apiResponse.js';
import { ApplicationPatch }      from '../../../../lib/schemas.js';
import { ValidationError, NotFoundError, UpstreamError } from '../../../../lib/errors.js';
import { log }                   from '../../../../lib/log.js';

export async function GET(req, { params }) {
  try {
    const { data, error } = await selectFrom('applications', { columns: '*, questions(*)' })
      .eq('id', params.id)
      .single();

    if (error) throw new NotFoundError(error.message);
    return ok({ application: data });
  } catch (err) {
    log.error('applications', 'get_one_failed', { err: err.message });
    return fail(err);
  }
}

export async function PATCH(req, { params }) {
  try {
    let body;
    try { body = await req.json(); }
    catch { throw new ValidationError('Invalid JSON'); }

    const parsed = ApplicationPatch.safeParse(body);
    if (!parsed.success) throw new ValidationError('Bad request', parsed.error.format());

    const allowed = ['name', 'org', 'url', 'deadline', 'status', 'project_key'];
    const updates = Object.fromEntries(
      Object.entries(parsed.data).filter(([k]) => allowed.includes(k)),
    );

    if (Object.keys(updates).length === 0) {
      throw new ValidationError('No valid fields to update');
    }

    const { data, error } = await supabase
      .from('applications')
      .update(updates)
      .eq('id', params.id)
      .select()
      .single();

    if (error) throw new UpstreamError(error.message);
    return ok({ application: data });
  } catch (err) {
    log.error('applications', 'patch_failed', { err: err.message });
    return fail(err);
  }
}

export async function DELETE(req, { params }) {
  try {
    // Soft-delete: preserves the row + audit trail. The
    // trg_propagate_soft_delete_questions trigger cascades deleted_at to child
    // questions automatically.
    const { error } = await softDelete('applications').eq('id', params.id);

    if (error) throw new UpstreamError(error.message);
    return ok({ ok: true });
  } catch (err) {
    log.error('applications', 'delete_failed', { err: err.message });
    return fail(err);
  }
}
