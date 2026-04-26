/**
 * POST /api/chat
 * Tiered multi-model chat endpoint.
 *
 * Flow:
 *   1. Normalise input (flat or messages[] format)
 *   2. Save user message to DB
 *   3. Classify tier → primaryModel + fallbackModel
 *   4. Tier 0 → handle in code, no AI
 *   5. Build system prompt (static cached block + dynamic block)
 *   6. Compress conversation history (rolling summary after 8 messages)
 *   7. Call primary model, auto-fallback to secondary
 *   8. Log cost
 *   9. Save assistant response
 *  10. Return { message, tier, model, provider, cached, reason, usage, cost, isEscalated, latencyMs }
 *
 * Accepts two body formats:
 *   Flat:  { projectKey, message, conversationHistory?, isEscalated? }
 *   Array: { messages[], projectKey?, appId?, questionId?, isEscalated? }
 */

import { NextResponse }              from 'next/server';
import { classifyTier }              from '../../../lib/tierClassifier.js';
import { callModelWithFallback }     from '../../../lib/multiModelClient.js';
import { compressHistory }           from '../../../lib/conversationManager.js';
import { buildSystemPrompt }         from '../../../lib/buildSystemPrompt.js';
import { logCost, calculateCost }    from '../../../lib/costLog.js';
import { PROJECTS }                  from '../../../lib/projects.js';
import { MODELS }                    from '../../../lib/models.js';
import { supabase, getMessages, addMessage, getProfile, getTasks } from '../../../lib/supabase.js';

export async function POST(req) {
  const startTime = Date.now();

  try {
    const body = await req.json();

    // ── 1. Normalise input ──────────────────────────────────────────────────
    let messages, projectKey, appId, questionId, isEscalated;

    if (body.message !== undefined) {
      // Flat format: { projectKey, message, conversationHistory?, isEscalated? }
      projectKey   = body.projectKey   ?? null;
      appId        = body.appId        ?? null;
      questionId   = body.questionId   ?? null;
      isEscalated  = body.isEscalated  ?? false;
      messages     = [
        ...(body.conversationHistory ?? []).map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: String(body.message) },
      ];
    } else {
      // Array format: { messages[], projectKey?, appId?, questionId?, isEscalated? }
      ({ messages, projectKey, appId, questionId } = body);
      isEscalated = body.isEscalated ?? false;
    }

    if (!messages?.length) {
      return NextResponse.json({ error: 'messages required' }, { status: 400 });
    }

    const userMessage = messages[messages.length - 1].content;

    // ── 2. Save user message ────────────────────────────────────────────────
    if (projectKey) {
      await addMessage(projectKey, 'user', userMessage).catch(() => {});
    }

    // ── 3. Get conversation history from DB ─────────────────────────────────
    const history = projectKey
      ? await getMessages(projectKey, 50).catch(() => [])
      : [];

    // ── 4. Classify tier ────────────────────────────────────────────────────
    const classification = classifyTier(userMessage, {
      projectKey,
      messageCount: history.length,
      isEscalated,
    });

    // ── 5. Tier 0: no AI ────────────────────────────────────────────────────
    if (classification.tier === 0) {
      const reply = `Done. (${classification.reason})`;
      if (projectKey) await addMessage(projectKey, 'assistant', reply, { tier: 0 }).catch(() => {});
      return NextResponse.json({
        message: reply, reply, tier: 0, model: null, provider: null,
        reason: classification.reason, usage: null, cost: null,
        isEscalated: false, latencyMs: Date.now() - startTime,
      });
    }

    // ── 6. Build system prompt ──────────────────────────────────────────────
    const projectDef = PROJECTS.find(p => p.key === projectKey);

    // Per-question context (goes into dynamic block, not cached)
    let dynamicContext = '';
    if (questionId) {
      const { data: question } = await supabase
        .from('questions')
        .select('text, category, applications(org, name)')
        .eq('id', questionId)
        .single();

      if (question) {
        dynamicContext += `Current question: "${question.text}" (category: ${question.category})`;
        if (question.applications) {
          dynamicContext += `\nApplication: ${question.applications.name} at ${question.applications.org}`;
        }
        const { data: base } = await supabase
          .from('base_answers')
          .select('content')
          .eq('category', question.category)
          .single();
        if (base?.content) {
          dynamicContext += `\n\nUser's base answer for "${question.category}" (adapt, don't copy):\n${base.content}`;
        }
      }
    }

    const tasks   = projectKey ? await getTasks(projectKey).catch(() => []) : [];
    const profile = await getProfile().catch(() => null);

    const systemPrompt = buildSystemPrompt(projectDef, profile, tasks, dynamicContext);

    // ── 7. Compress conversation history ────────────────────────────────────
    const historyMessages = history.map(m => ({
      role:    m.role === 'system' ? 'user' : m.role,
      content: m.content,
    }));
    // Include current message in compression window, then separate it out
    const compressedHistory = await compressHistory(historyMessages);
    const apiMessages = [...compressedHistory, { role: 'user', content: userMessage }];

    // ── 8. Call model with automatic fallback ───────────────────────────────
    const result = await callModelWithFallback(
      classification.primaryModel,
      classification.fallbackModel,
      {
        system:    systemPrompt,
        messages:  apiMessages,
        maxTokens: classification.maxTokens,
      },
    );

    // ── 9. Log cost ──────────────────────────────────────────────────────────
    const cost = calculateCost(result.modelKey, result.usage);
    await logCost(result.modelKey, result.usage, {
      projectKey,
      cached:     result.cached,
      reason:     classification.reason,
      latencyMs:  Date.now() - startTime,
    });

    // ── 10. Save assistant response ──────────────────────────────────────────
    const meta = {
      tier:     classification.tier,
      model:    result.model,
      provider: result.provider,
      cached:   result.cached,
      usage:    result.usage,
    };
    if (projectKey) await addMessage(projectKey, 'assistant', result.text, meta).catch(() => {});
    if (appId || questionId) {
      try {
        await supabase.from('chat_messages').insert([
          { application_id: appId ?? null, question_id: questionId ?? null, role: 'user',      content: userMessage   },
          { application_id: appId ?? null, question_id: questionId ?? null, role: 'assistant', content: result.text },
        ]);
      } catch { /* non-fatal */ }
    }

    return NextResponse.json({
      message:     result.text,
      reply:       result.text,
      tier:        classification.tier,
      model:       result.model,
      provider:    result.provider,
      cached:      result.cached,
      reason:      classification.reason,
      usage:       result.usage,
      cost,
      isEscalated: classification.tier === 3,
      latencyMs:   Date.now() - startTime,
    });

  } catch (err) {
    console.error('[Chat] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
