/**
 * PATCH  /api/items/:id  — update any field on an item (status, title, notes, due_date, position).
 *                          Falls back to applications table for research_apps.
 * DELETE /api/items/:id  — soft-delete: sets deleted_at on the row instead of
 *                          issuing a hard DELETE (preserves audit trail).
 */

import { NextResponse }           from 'next/server';
import { supabase }               from '../../../../lib/supabase.js';
import { selectFrom, softDelete } from '../../../../lib/supabaseQuery.js';

export async function PATCH(req, { params }) {
  const { id }  = params;
  const updates = await req.json();

  // Try items table first (soft-delete-aware lookup)
  const { data: existing } = await selectFrom('items', { columns: 'id' })
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

export async function DELETE(req, { params }) {
  const { id } = params;

  // Soft-delete preserves audit history. The trg_propagate_soft_delete_questions
  // trigger cascades deleted_at to child questions when an application row is
  // soft-deleted. Try items first; if zero rows matched, fall back to
  // applications (research_apps stores rows there, not in items).
  const itemsRes = await softDelete('items').eq('id', id).select('id');
  if (itemsRes.error) {
    return NextResponse.json({ error: itemsRes.error.message }, { status: 500 });
  }
  if (itemsRes.data?.length) return NextResponse.json({ ok: true });

  const appsRes = await softDelete('applications').eq('id', id).select('id');
  if (appsRes.error) {
    return NextResponse.json({ error: appsRes.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
