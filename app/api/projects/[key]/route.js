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

  return NextResponse.json({ applications: data ?? [] });
}

export async function PATCH(req, { params }) {
  const { key } = params;
  const body = await req.json();

  // Reserved for project-level settings (name, colour, archived, etc.)
  // For now just echo back
  return NextResponse.json({ project: key, updated: body });
}
