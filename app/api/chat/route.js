/**
 * POST /api/chat
 * Tiered multi-model chat endpoint.
 *
 * Flow:
 *   1. Classify message → tier (0/1/2/3) + model
 *   2. Tier 0 → handle in code, no AI
 *   3. Build system prompt from project def + tasks + profile
 *   4. Compress conversation history (rolling summary after 8 messages)
 *   5. Call selected model
 *   6. Log cost
 *   7. Return { message, tier, model, provider, cached, reason, usage, cost }
 *
 * Accepts two body formats:
 *   - Flat:  { projectKey, message }
 *   - Array: { messages[], projectKey?, appId?, questionId? }
 */

import { NextResponse }               from 'next/server';
import { classifyTier }               from '../../../lib/tierClassifier.js';
import { chatWithModel }              from '../../../lib/multiModelClient.js';
import { manageConversationHistory }  from '../../../lib/conversationManager.js';
import { logCost, calculateCost }     from '../../../lib/costTracker.js';
import { PROJECTS }                   from '../../../lib/projects.js';
import { supabase, getMessages, addMessage, getProfile, getTasks } from '../../../lib/supabase.js';

export async function POST(req) {
  try {
    const body = await req.json();

    // ── Normalise input format ──────────────────────────────────────────────
    let messages, projectKey, appId, questionId;

    if (body.message !== undefined) {
      // Flat format
      projectKey = body.projectKey ?? null;
      appId      = body.appId      ?? null;
      questionId = body.questionId ?? null;
      messages   = [{ role: 'user', content: String(body.message) }];
    } else {
      ({ messages, projectKey, appId, questionId } = body);
    }

    if (!messages?.length) {
      return NextResponse.json({ error: 'messages required' }, { status: 400 });
    }

    const userMessage = messages[messages.length - 1].content;

    // ── 1. Save user message ────────────────────────────────────────────────
    if (projectKey) {
      await addMessage(projectKey, 'user', userMessage).catch(() => {});
    }

    // ── 2. Get conversation history ─────────────────────────────────────────
    const history = projectKey
      ? await getMessages(projectKey, 50).catch(() => [])
      : [];

    // ── 3. Classify tier ────────────────────────────────────────────────────
    const classification = classifyTier(userMessage, {
      projectKey,
      messageCount:   history.length,
      recentMessages: history.slice(-3).map(m => m.content),
      isEscalated:    history.some(m => m.metadata?.tier === 3),
    });

    // ── 4. Tier 0: no AI ────────────────────────────────────────────────────
    if (classification.tier === 0) {
      const reply = `Done. (${classification.reason})`;
      if (projectKey) await addMessage(projectKey, 'assistant', reply, { tier: 0 }).catch(() => {});
      return NextResponse.json({ message: reply, reply, tier: 0, model: null, reason: classification.reason, usage: null, cost: null });
    }

    // ── 5. Build system prompt ──────────────────────────────────────────────
    const projectDef = PROJECTS.find(p => p.key === projectKey);
    let systemPrompt = projectDef?.system_prompt ?? 'You are a helpful assistant.';

    // Add per-question context if we're in the question chat (questionId provided)
    if (questionId) {
      const { data: question } = await supabase
        .from('questions')
        .select('text, category, applications(org, name)')
        .eq('id', questionId)
        .single();

      if (question) {
        systemPrompt += `\n\nCurrent question: "${question.text}" (category: ${question.category})`;
        if (question.applications) {
          systemPrompt += `\nApplication: ${question.applications.name} at ${question.applications.org}`;
        }
        const { data: base } = await supabase
          .from('base_answers')
          .select('content')
          .eq('category', question.category)
          .single();
        if (base?.content) {
          systemPrompt += `\n\nUser's base answer for "${question.category}" (adapt, don't copy):\n${base.content}`;
        }
      }
    }

    // Inject open tasks (static section — gets prompt-cached)
    const tasks = projectKey ? await getTasks(projectKey).catch(() => []) : [];
    if (tasks.length > 0) {
      systemPrompt += `\n\nOpen tasks:\n${tasks.slice(0, 15).map(t => `- [${t.status}] ${t.text}`).join('\n')}`;
    }

    // Inject profile (static section — gets prompt-cached)
    const profile = await getProfile().catch(() => null);
    if (profile) {
      systemPrompt += `\n\nUser profile:\n${JSON.stringify(profile)}`;
    }

    // Tier-specific response style (appended AFTER static section — not cached)
    const tierInstructions = {
      1: '\n\nRespond in 1-2 sentences maximum. Be extremely concise.',
      2: '\n\nKeep responses to 2-4 sentences. Be direct, no filler.',
      3: '\n\nThis is a deep discussion. Be thorough, nuanced, and intellectually honest. Challenge assumptions when appropriate.',
    };
    systemPrompt += tierInstructions[classification.tier] ?? '';

    // ── 6. Compress conversation history ────────────────────────────────────
    const historyMessages = history.map(m => ({
      role:    m.role === 'system' ? 'user' : m.role,
      content: m.content,
    }));
    const managedHistory = await manageConversationHistory(historyMessages);

    // Current message is not yet in history — append it
    const apiMessages = [...managedHistory, { role: 'user', content: userMessage }];

    // ── 7. Call model ────────────────────────────────────────────────────────
    const result = await chatWithModel(classification.model, {
      system:    systemPrompt,
      messages:  apiMessages,
      maxTokens: classification.maxTokens,
    });

    // ── 8. Log cost ──────────────────────────────────────────────────────────
    const cost = calculateCost(result.modelKey, result.usage);
    await logCost(result.modelKey, result.usage, { projectKey, cached: result.cached });

    // ── 9. Save assistant response ───────────────────────────────────────────
    const meta = { tier: classification.tier, model: result.model, provider: result.provider, cached: result.cached, usage: result.usage };
    if (projectKey)  await addMessage(projectKey, 'assistant', result.text, meta).catch(() => {});
    if (appId || questionId) {
      await supabase.from('chat_messages').insert([
        { application_id: appId ?? null, question_id: questionId ?? null, role: 'user', content: userMessage },
        { application_id: appId ?? null, question_id: questionId ?? null, role: 'assistant', content: result.text },
      ]).catch(() => {});
    }

    return NextResponse.json({
      message:  result.text,
      reply:    result.text,
      tier:     classification.tier,
      model:    result.model,
      provider: result.provider,
      cached:   result.cached,
      reason:   classification.reason,
      usage:    result.usage,
      cost,
    });

  } catch (err) {
    console.error('[Chat] Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
