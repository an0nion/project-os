/**
 * GET    /api/applications/:id  — fetch single application with questions
 * PATCH  /api/applications/:id  — update fields (status, name, org, deadline, etc.)
 * DELETE /api/applications/:id  — delete application + cascades to questions/chat
 */

import { NextResponse } from 'next/server';
import { supabase }     from '../../../../lib/supabase.js';

export async function GET(req, { params }) {
  const { data, error } = await supabase
    .from('applications')
    .select('*, questions(*)')
    .eq('id', params.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 404 });
  return NextResponse.json({ application: data });
}

export async function PATCH(req, { params }) {
  const body = await req.json();

  const allowed = ['name', 'org', 'url', 'deadline', 'status', 'project_key'];
  const updates = Object.fromEntries(
    Object.entries(body).filter(([k]) => allowed.includes(k)),
  );

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('applications')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ application: data });
}

export async function DELETE(req, { params }) {
  const { error } = await supabase
    .from('applications')
    .delete()
    .eq('id', params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
