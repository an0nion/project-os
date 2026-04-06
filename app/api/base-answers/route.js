/**
 * GET  /api/base-answers  — list all base answers (user's reusable templates)
 * POST /api/base-answers  — create a base answer for a new category
 */

import { NextResponse } from 'next/server';
import { supabase }     from '../../../lib/supabase.js';

export async function GET() {
  const { data, error } = await supabase
    .from('base_answers')
    .select('*')
    .order('category');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ baseAnswers: data ?? [] });
}

export async function POST(req) {
  const { category, content } = await req.json();
  if (!category || content === undefined) {
    return NextResponse.json({ error: 'category and content required' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('base_answers')
    .upsert({ category, content }, { onConflict: 'category' })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ baseAnswer: data }, { status: 201 });
}
