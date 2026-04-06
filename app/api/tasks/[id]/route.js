/**
 * PATCH /api/tasks/:id — update a question/task (answer, status)
 * DELETE /api/tasks/:id — remove a question
 *
 * Body for PATCH: { answer?, status?, category? }
 */

import { NextResponse } from 'next/server';
import { supabase }     from '../../../../lib/supabase.js';

export async function PATCH(req, { params }) {
  const { id } = params;
  const body   = await req.json();

  const allowed = ['answer', 'status', 'category', 'base_answer_id'];
  const updates = Object.fromEntries(
    Object.entries(body).filter(([k]) => allowed.includes(k)),
  );

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('questions')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ question: data });
}

export async function DELETE(req, { params }) {
  const { id } = params;

  const { error } = await supabase.from('questions').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
