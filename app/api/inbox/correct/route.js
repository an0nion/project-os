/**
 * POST /api/inbox/correct
 * Record a user correction on a previously logged inbox item.
 *
 * Body: { logId, correctedProject, note? }
 */

import { supabase }       from '../../../../lib/supabase.js';
import { ok, fail }       from '../../../../lib/apiResponse.js';
import { InboxCorrectPost } from '../../../../lib/schemas.js';
import { ValidationError, UpstreamError } from '../../../../lib/errors.js';
import { log }            from '../../../../lib/log.js';

export async function POST(req) {
  try {
    let body;
    try { body = await req.json(); }
    catch { throw new ValidationError('Invalid JSON'); }

    const parsed = InboxCorrectPost.safeParse(body);
    if (!parsed.success) throw new ValidationError('Bad request', parsed.error.format());

    const { logId, correctedProject, note } = parsed.data;

    const { error } = await supabase
      .from('inbox_log')
      .update({
        corrected_project: correctedProject,
        correction_note:   note ?? null,
        is_correction:     true,
      })
      .eq('id', logId);

    if (error) throw new UpstreamError(error.message);
    return ok({ ok: true, correctedProject });
  } catch (err) {
    log.error('inbox:correct', 'failed', { err: err.message });
    return fail(err);
  }
}
