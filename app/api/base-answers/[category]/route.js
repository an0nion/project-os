/**
 * GET /api/base-answers/:category  — fetch one base answer
 * PUT /api/base-answers/:category  — create or replace a base answer
 */

import { supabase }       from '../../../../lib/supabase.js';
import { ok, fail }       from '../../../../lib/apiResponse.js';
import { BaseAnswerPut }  from '../../../../lib/schemas.js';
import { ValidationError, NotFoundError, UpstreamError } from '../../../../lib/errors.js';
import { log }            from '../../../../lib/log.js';

export async function GET(req, { params }) {
  try {
    const { data, error } = await supabase
      .from('base_answers')
      .select('*')
      .eq('category', params.category)
      .single();

    if (error) throw new NotFoundError('Not found');
    return ok({ baseAnswer: data });
  } catch (err) {
    log.error('base-answers', 'get_one_failed', { err: err.message });
    return fail(err);
  }
}

export async function PUT(req, { params }) {
  try {
    let body;
    try { body = await req.json(); }
    catch { throw new ValidationError('Invalid JSON'); }

    const parsed = BaseAnswerPut.safeParse(body);
    if (!parsed.success) throw new ValidationError('Bad request', parsed.error.format());

    const { content } = parsed.data;

    const { data, error } = await supabase
      .from('base_answers')
      .upsert({ category: params.category, content }, { onConflict: 'category' })
      .select()
      .single();

    if (error) throw new UpstreamError(error.message);
    return ok({ baseAnswer: data });
  } catch (err) {
    log.error('base-answers', 'put_failed', { err: err.message });
    return fail(err);
  }
}
