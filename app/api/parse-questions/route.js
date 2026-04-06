/**
 * POST /api/parse-questions
 * Parse user-pasted question text and optionally save to an application.
 *
 * Body: { text, appId?, useAi? }
 * Response: { questions }
 */

import { NextResponse }        from 'next/server';
import { smartParseQuestions } from '../../../parser/questionParser.js';
import { supabase }            from '../../../lib/supabase.js';

export async function POST(req) {
  const { text, appId, useAi = false } = await req.json();
  if (!text) return NextResponse.json({ error: 'text required' }, { status: 400 });

  const questions = await smartParseQuestions(text, useAi);

  // Persist if an application id was provided
  if (appId && questions.length > 0) {
    const { data } = await supabase
      .from('questions')
      .insert(
        questions.map(q => ({
          application_id: appId,
          text:           q.text,
          category:       q.category,
          answer:         '',
          status:         'pending',
        })),
      )
      .select();

    return NextResponse.json({ questions: data ?? questions });
  }

  return NextResponse.json({ questions });
}
