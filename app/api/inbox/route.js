/**
 * POST /api/inbox
 * Universal entry point for all captured items (Slack, bookmarklet, PWA share target).
 * Routes the item to a project via keyword match then AI fallback (free model).
 *
 * Body: { url?, text?, source? }
 * Response: { project, projectLabel, confidence, summary, suggested_action, is_new_task,
 *             appId?, questionsCount?, deadline?, routedBy, routingCost }
 */

import { NextResponse }      from 'next/server';
import { route }             from '../../../lib/router.js';
import { scrapeApplication } from '../../../scraper/index.js';
import { supabase }          from '../../../lib/supabase.js';

export async function POST(req) {
  const { url, text, source } = await req.json();

  if (!url && !text) {
    return NextResponse.json({ error: 'url or text required' }, { status: 400 });
  }

  // ── Route to project (keyword match → gemini-flash free → deepseek fallback) ──
  const routeInput = text || url;
  const { project, projectLabel, confidence, summary, suggested_action, is_new_task } = await route(routeInput);

  // ── Scrape URL if provided ──────────────────────────────────────────────────
  let appId          = null;
  let questionsCount = 0;
  let deadline       = null;
  let scrapeError    = null;

  if (url) {
    const scraped = await scrapeApplication(url);

    if (!scraped.error) {
      const { data: app, error: appErr } = await supabase
        .from('applications')
        .insert({
          name:          scraped.position || 'Untitled Application',
          org:           scraped.org      || 'Unknown',
          url,
          deadline:      scraped.deadline || null,
          status:        'backlog',
          project_key:   project,
          scrape_method: scraped.method,
        })
        .select()
        .single();

      if (!appErr && app) {
        appId    = app.id;
        deadline = scraped.deadline;

        if (scraped.questions?.length) {
          await supabase.from('questions').insert(
            scraped.questions.map(q => ({
              application_id: app.id,
              text:           q.text,
              category:       q.category,
              answer:         '',
              status:         'pending',
            })),
          );
          questionsCount = scraped.questions.length;
        }
      }
    } else {
      scrapeError = scraped.error;
    }
  }

  // ── Audit log ───────────────────────────────────────────────────────────────
  try {
    await supabase.from('inbox_log').insert({
      source:  source ?? 'unknown',
      url:     url    ?? null,
      text:    text   ?? null,
      project,
      summary,
    });
  } catch { /* non-fatal */ }

  return NextResponse.json({
    project,
    projectLabel,
    confidence,
    summary,
    suggested_action,
    is_new_task,
    appId,
    questionsCount,
    deadline,
    routedBy:    'gemini-flash',
    routingCost: 0,
    source:      source ?? 'unknown',
    ...(scrapeError ? { error: scrapeError } : {}),
  });
}
