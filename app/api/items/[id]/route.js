/**
 * PATCH /api/items/:id
 * Update any field on an item (status, title, notes, due_date, position).
 *
 * Also handles research_apps applications via the applications table.
 */

import { NextResponse } from 'next/server';
import { supabase }     from '../../../../lib/supabase.js';

export async function PATCH(req, { params }) {
  const { id }  = params;
  const updates = await req.json();

  // Try items table first
  const { data: existing } = await supabase
    .from('items')
    .select('id')
    .eq('id', id)
    .single();

  if (existing) {
    const allowed = ['title', 'subtitle', 'status', 'due_date', 'url', 'notes', 'position'];
    const patch   = Object.fromEntries(
      Object.entries(updates).filter(([k]) => allowed.includes(k))
    );
    const { data, error } = await supabase
      .from('items')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  // Fall back to applications table (research_apps)
  const allowed = ['status', 'deadline', 'name', 'org'];
  const patch   = Object.fromEntries(
    Object.entries(updates).filter(([k]) => allowed.includes(k))
  );
  const { data, error } = await supabase
    .from('applications')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
