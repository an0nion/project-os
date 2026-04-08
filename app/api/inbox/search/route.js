/**
 * GET /api/inbox/search?q=topic&limit=5
 * Full-text search across saved items and inbox log.
 * Used by the Slack bot recall intent.
 *
 * Returns: { results: [{ title, project, url, saved_at }] }
 */

import { NextResponse } from 'next/server';
import { supabase }     from '../../../../lib/supabase.js';
import { PROJECTS }     from '../../../../lib/projects.js';

export async function GET(req) {
  const secret = req.headers.get('x-api-secret');
  if (!secret || secret !== process.env.APP_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q     = searchParams.get('q')?.trim();
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '5', 10), 20);

  if (!q) return NextResponse.json({ error: 'q required' }, { status: 400 });

  // Search items table (title ILIKE) and inbox_log (summary ILIKE), merge, deduplicate
  const [itemsRes, logRes] = await Promise.all([
    supabase
      .from('items')
      .select('id, title, project_key, url, created_at')
      .ilike('title', `%${q}%`)
      .order('created_at', { ascending: false })
      .limit(limit),

    supabase
      .from('inbox_log')
      .select('id, summary, project, url, created_at')
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
      title:    row.title,
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

  // Sort by recency, cap at limit
  results.sort((a, b) => new Date(b.saved_at) - new Date(a.saved_at));
  results.splice(limit);

  return NextResponse.json({ results });
}
