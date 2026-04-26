/**
 * GET /api/inbox/search?q=topic&limit=5
 * Full-text search across saved items and inbox log.
 * Used by the Slack bot recall intent.
 *
 * Soft-delete-aware: rows with deleted_at IS NOT NULL are hidden via lib/supabaseQuery.js.
 */

import { selectFrom }       from '../../../../lib/supabaseQuery.js';
import { ok, fail }         from '../../../../lib/apiResponse.js';
import { InboxSearchQuery } from '../../../../lib/schemas.js';
import { ValidationError, AuthError } from '../../../../lib/errors.js';
import { log }              from '../../../../lib/log.js';

export async function GET(req) {
  try {
    const secret = req.headers.get('x-api-secret');
    if (!secret || secret !== process.env.APP_SECRET) {
      throw new AuthError();
    }

    const { searchParams } = new URL(req.url);
    const parsed = InboxSearchQuery.safeParse({
      q:     searchParams.get('q')?.trim() ?? '',
      limit: searchParams.get('limit') ?? undefined,
    });
    if (!parsed.success) throw new ValidationError('Bad request', parsed.error.format());
    const { q, limit } = parsed.data;

    const [itemsRes, logRes] = await Promise.all([
      selectFrom('items', {
        columns: 'id, title, subtitle, notes, project_key, url, created_at',
      })
        .or(`title.ilike.%${q}%,subtitle.ilike.%${q}%,notes.ilike.%${q}%`)
        .order('created_at', { ascending: false })
        .limit(limit),

      selectFrom('inbox_log', {
        columns: 'id, summary, project, url, created_at',
      })
        .ilike('summary', `%${q}%`)
        .order('created_at', { ascending: false })
        .limit(limit),
    ]);

    const seen    = new Set();
    const results = [];

    for (const row of (itemsRes.data ?? [])) {
      const key = row.url ?? row.title;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        id:       row.id,
        title:    row.title,
        subtitle: row.subtitle ?? null,
        project:  row.project_key,
        url:      row.url ?? null,
        saved_at: row.created_at,
      });
    }

    for (const row of (logRes.data ?? [])) {
      const key = row.url ?? row.summary;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        title:    row.summary,
        project:  row.project,
        url:      row.url ?? null,
        saved_at: row.created_at,
      });
    }

    results.sort((a, b) => new Date(b.saved_at) - new Date(a.saved_at));
    results.splice(limit);

    return ok({ results });
  } catch (err) {
    log.error('inbox:search', 'failed', { err: err.message });
    return fail(err);
  }
}
