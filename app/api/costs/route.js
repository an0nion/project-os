/**
 * GET /api/costs
 * Returns spend breakdown by tier, provider, and time period.
 *
 * Query params:
 *   period=today|week|month (default: month)
 *
 * Response:
 *   { total, byTier, byProvider, byProject, recent, period }
 */

import { NextResponse } from 'next/server';
import { supabase }     from '../../../lib/supabase.js';

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const period = searchParams.get('period') ?? 'month';

  const since = new Date();
  if      (period === 'today') since.setHours(0, 0, 0, 0);
  else if (period === 'week')  since.setDate(since.getDate() - 7);
  else                         since.setDate(1); // start of month

  const { data, error } = await supabase
    .from('cost_log')
    .select('*')
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];

  // Aggregate
  const total = rows.reduce((s, r) => s + Number(r.cost_usd), 0);

  const byTier = rows.reduce((acc, r) => {
    const key = `tier_${r.tier}`;
    acc[key] = (acc[key] ?? 0) + Number(r.cost_usd);
    return acc;
  }, {});

  const byProvider = rows.reduce((acc, r) => {
    acc[r.provider] = (acc[r.provider] ?? 0) + Number(r.cost_usd);
    return acc;
  }, {});

  const byProject = rows.reduce((acc, r) => {
    const k = r.project_key ?? 'unknown';
    acc[k] = (acc[k] ?? 0) + Number(r.cost_usd);
    return acc;
  }, {});

  // Keep full precision — frontend formats with toFixed(4/6)
  return NextResponse.json({
    period,
    since:      since.toISOString(),
    total,
    byTier,
    byProvider,
    byProject,
    recent:     rows.slice(0, 20).map(r => ({
      model:       r.model,
      provider:    r.provider,
      tier:        r.tier,
      cost:        Number(r.cost_usd),
      cached:      r.cached,
      projectKey:  r.project_key,
      at:          r.created_at,
    })),
  });
}
