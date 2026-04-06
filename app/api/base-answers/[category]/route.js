/**
 * GET /api/base-answers/:category  — fetch one base answer
 * PUT /api/base-answers/:category  — create or replace a base answer
 */

import { NextResponse } from 'next/server';
import { supabase }     from '../../../../lib/supabase.js';

export async function GET(req, { params }) {
  const { data, error } = await supabase
    .from('base_answers')
    .select('*')
    .eq('category', params.category)
    .single();

  if (error) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ baseAnswer: data });
}

export async function PUT(req, { params }) {
  const { content } = await req.json();
  if (content === undefined) {
    return NextResponse.json({ error: 'content required' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('base_answers')
    .upsert({ category: params.category, content }, { onConflict: 'category' })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ baseAnswer: data });
}
