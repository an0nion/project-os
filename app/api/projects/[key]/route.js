/**
 * GET  /api/projects/:key   — list all applications in a project
 * PATCH /api/projects/:key  — update project-level metadata (future use)
 */

import { NextResponse } from 'next/server';
import { supabase }     from '../../../../lib/supabase.js';

export async function GET(req, { params }) {
  const { key } = params;

  const { data, error } = await supabase
    .from('applications')
    .select('*, questions(*)')
    .eq('project_key', key)
    .order('deadline', { ascending: true, nullsFirst: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Item count — items table for all projects except research_apps (uses applications)
  let itemCount = 0;
  if (key === 'research_apps') {
    itemCount = (data ?? []).length;
  } else {
    const { count } = await supabase
      .from('items')
      .select('*', { count: 'exact', head: true })
      .eq('project_key', key);
    itemCount = count ?? 0;
  }

  return NextResponse.json({ applications: data ?? [], inboxCount: itemCount });
}

export async function PATCH(req, { params }) {
  const { key } = params;
  const body = await req.json();

  // Reserved for project-level settings (name, colour, archived, etc.)
  // For now just echo back
  return NextResponse.json({ project: key, updated: body });
}
