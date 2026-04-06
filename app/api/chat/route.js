/**
 * POST /api/chat
 * Per-question conversational drafting via Claude.
 *
 * Body: { messages, appId?, questionId? }
 *   messages: [{role: 'user'|'assistant', content: string}]
 * Response: { reply }
 *
 * System prompt is assembled from:
 *   - The question text (fetched from DB by questionId)
 *   - Base answer for that category (if stored)
 *   - Application context (org, position)
 */

import { NextResponse } from 'next/server';
import { chat }         from '../../../lib/claude.js';
import { supabase }     from '../../../lib/supabase.js';

export async function POST(req) {
  const body = await req.json();

  // Support two call formats:
  //   1. Flat:  { projectKey, message }          ← used by QA console + Slack bot
  //   2. Array: { messages, appId, questionId }  ← used by project page chat
  let messages, appId, questionId, projectKey;

  if (body.message !== undefined) {
    // Flat format — normalise into messages array
    projectKey = body.projectKey ?? null;
    appId      = body.appId      ?? null;
    questionId = body.questionId ?? null;
    messages   = [{ role: 'user', content: String(body.message) }];
  } else {
    ({ messages, appId, questionId } = body);
  }

  if (!messages?.length) return NextResponse.json({ error: 'messages required' }, { status: 400 });

  // Build system context — generalise based on projectKey if provided
  const PROJECT_PERSONAS = {
    research_apps: 'You are an expert fellowship and research application advisor. Help the user draft thoughtful, specific, and compelling answers.',
    learning_tech: 'You are a knowledgeable tech and learning guide. Help the user understand concepts clearly and practically.',
    reading:       'You are a thoughtful literary and philosophical discussion partner. Help the user explore ideas from texts.',
    baking:        'You are an expert baker. Give precise, practical baking guidance with ratios and techniques.',
    exercise:      'You are a knowledgeable fitness coach. Give clear, safe, evidence-based training advice.',
    art:           'You are a creative art and making guide. Help the user with techniques, materials, and creative direction.',
  };

  const persona = PROJECT_PERSONAS[projectKey] ?? 'You are a helpful assistant.';
  let systemContext = `${persona}\nBe direct — give concrete answers and explain your reasoning. Keep responses concise unless more length is requested.`;

  if (questionId) {
    const { data: question } = await supabase
      .from('questions')
      .select('text, category, application_id, applications(org, name)')
      .eq('id', questionId)
      .single();

    if (question) {
      systemContext += `\n\nCurrent question:\n"${question.text}"`;
      systemContext += `\nCategory: ${question.category}`;
      if (question.applications) {
        systemContext += `\nApplication: ${question.applications.name} at ${question.applications.org}`;
      }

      // Load base answer for reuse context
      const { data: base } = await supabase
        .from('base_answers')
        .select('content')
        .eq('category', question.category)
        .single();

      if (base?.content) {
        systemContext += `\n\nUser's existing base answer for "${question.category}" (adapt this, don't copy verbatim):\n${base.content}`;
      }
    }
  }

  // claude.js returns the text; call the raw API to also capture usage
  const reply = await chat({ system: systemContext, messages, maxTokens: 1500 });
  // usage is not exposed by our thin wrapper — approximate it
  const usage = {
    input_tokens:  Math.ceil(systemContext.length / 4) + messages.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0),
    output_tokens: Math.ceil(reply.length / 4),
  };

  // Save assistant turn to chat history
  if (appId || questionId) {
    await supabase.from('chat_messages').insert([
      ...messages.slice(-1).map(m => ({
        application_id: appId ?? null,
        question_id:    questionId ?? null,
        role:           m.role,
        content:        m.content,
      })),
      {
        application_id: appId ?? null,
        question_id:    questionId ?? null,
        role:           'assistant',
        content:        reply,
      },
    ]);
  }

  return NextResponse.json({ reply, message: reply, usage });
}
