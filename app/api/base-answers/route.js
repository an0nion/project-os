/**
 * GET  /api/base-answers  — list all base answers (user's reusable templates)
 * POST /api/base-answers  — create a base answer for a new category
 */

import { supabase }       from '../../../lib/supabase.js';
import { ok, fail }       from '../../../lib/apiResponse.js';
import { BaseAnswerPost } from '../../../lib/schemas.js';
import { ValidationError, UpstreamError } from '../../../lib/errors.js';
import { log }            from '../../../lib/log.js';

export async function GET() {
  try {
    const { data, error } = await supabase
      .from('base_answers')
      .select('*')
      .order('category');

    if (error) throw new UpstreamError(error.message);
    return ok({ baseAnswers: data ?? [] });
  } catch (err) {
    log.error('base-answers', 'get_failed', { err: err.message });
    return fail(err);
  }
}

export async function POST(req) {
  try {
    let body;
    try { body = await req.json(); }
    catch { throw new ValidationError('Invalid JSON'); }

    const parsed = BaseAnswerPost.safeParse(body);
    if (!parsed.success) throw new ValidationError('Bad request', parsed.error.format());

    const { category, content } = parsed.data;

    const { data, error } = await supabase
      .from('base_answers')
      .upsert({ category, content }, { onConflict: 'category' })
      .select()
      .single();

    if (error) throw new UpstreamError(error.message);
    return ok({ baseAnswer: data }, { status: 201 });
  } catch (err) {
    log.error('base-answers', 'post_failed', { err: err.message });
    return fail(err);
  }
}
