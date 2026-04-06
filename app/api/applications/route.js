/**
 * GET  /api/applications        — list all applications (optional ?project= filter)
 * POST /api/applications        — create application manually (without scraping)
 */

import { NextResponse } from 'next/server';
import { supabase }     from '../../../lib/supabase.js';

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const projectKey = searchParams.get('project');

  let query = supabase
    .from('applications')
    .select('*, questions(*)')
    .order('deadline', { ascending: true, nullsFirst: false });

  if (projectKey) query = query.eq('project_key', projectKey);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ applications: data ?? [] });
}

export async function POST(req) {
  const body = await req.json();
  const { name, org, url, deadline, projectKey = 'research_apps' } = body;

  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });

  const { data, error } = await supabase
    .from('applications')
    .insert({ name, org: org ?? '', url: url ?? null, deadline: deadline ?? null, project_key: projectKey, status: 'backlog' })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ application: data }, { status: 201 });
}
