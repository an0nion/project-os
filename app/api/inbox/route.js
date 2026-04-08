/**
 * POST /api/inbox
 * Universal entry point for all captured items (Slack, bookmarklet, PWA share target).
 * Routes the item to a project, then creates a Kanban card in the right table.
 *
 * Body: { url?, text?, source?, project? }
 *   project: optional forced project key (used by Slack bot after clarification)
 *
 * Behaviour by project type:
 *   research_apps — scrapes URL, creates row in applications + questions tables
 *   all others    — creates row in items table (generic Kanban card)
 *   GitHub/GitLab — never scraped; always creates an item (not an application)
 *
 * Title priority for items:
 *   1. Page <title> fetched from URL (lightweight, no scraping)
 *   2. AI router summary (for text-only or when fetch fails)
 *   3. Last path segment of URL
 *
 * Response: { project, projectLabel, confidence, summary, suggested_action,
 *             is_new_task, itemId?, appId?, questionsCount?, deadline?,
 *             routedBy, routingCost }
 */

import { NextResponse }           from 'next/server';
import { route }                  from '../../../lib/router.js';
import { scrapeApplication }      from '../../../scraper/index.js';
import { supabase }               from '../../../lib/supabase.js';
import { PROJECTS }               from '../../../lib/projects.js';
import { chatWithModel }          from '../../../lib/multiModelClient.js';
import { logCost }                from '../../../lib/costTracker.js';

// ── Fetch page HTML (title + body text for AI summary) ───────────────────────
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}

async function fetchPageMeta(url) {
  try {
    const res    = await fetch(url, {
      signal:  AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProjectOS/1.0)' },
    });
    const reader = res.body.getReader();
    let html = '';
    // Read up to 20 KB — enough for <head> + first few paragraphs of body
    while (html.length < 20000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
    }
    reader.cancel();

    const titleMatch = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    const title      = titleMatch ? decodeHtmlEntities(titleMatch[1]) : null;

    // Strip all tags, collapse whitespace → readable plain text for AI
    const bodyText = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1500);   // first ~1500 chars of readable content

    return { title, bodyText };
  } catch {
    return { title: null, bodyText: null };
  }
}

// ── AI one-liner: factual, specific, no marketing ────────────────────────────
async function generateDescription(title, bodyText, url) {
  if (!bodyText && !title) return null;
  const content = [title, bodyText].filter(Boolean).join('\n').slice(0, 1200);
  try {
    const result = await chatWithModel('gemini-flash', {
      system:   'You write one-sentence descriptions of web pages. Be specific and factual — describe what it actually is and does, not marketing language. Max 20 words. No full stop at the end.',
      messages: [{ role: 'user', content: `URL: ${url}\n\n${content}` }],
      maxTokens: 60,
    });
    logCost(result.modelKey, result.usage, { reason: 'page_description' }).catch(() => {});
    return result.text?.trim().replace(/\.$/, '') ?? null;
  } catch {
    return null;
  }
}

// ── Context subtitle from text (e.g. "For Work · urgent", "Personal · 1-2 months") ──
function extractSubtitle(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const parts = [];
  if (/\bfor work\b|\[work\]/i.test(text))               parts.push('Work');
  else if (/\bpersonal\b|\[personal\]/i.test(text))       parts.push('Personal');
  if (/\btoday\b|\burgent\b|\basap\b/i.test(lower))       parts.push('Urgent');
  else if (/\bthis week\b|\bsoon\b/i.test(lower))         parts.push('Soon');
  else if (/(\d+[-–]\d+\s*(month|week|day))/i.test(text)) {
    const m = text.match(/(\d+[-–]\d+\s*(month|week|day)s?)/i);
    if (m) parts.push(m[0]);
  }
  return parts.length ? parts.join(' · ') : null;
}

export async function POST(req) {
  const { url, text, source, project: forcedProject } = await req.json();

  if (!url && !text) {
    return NextResponse.json({ error: 'url or text required' }, { status: 400 });
  }

  // ── 1. Route to project ─────────────────────────────────────────────────────
  let project, projectLabel, confidence, summary, suggested_action, is_new_task;
  let modelProject    = null;   // what the router predicted (training signal)
  let modelConfidence = null;

  if (forcedProject) {
    // Bot forced routing after clarification — still run router to capture prediction
    const routeInput = text || url;
    const prediction = await route(routeInput).catch(() => null);
    modelProject     = prediction?.project    ?? null;
    modelConfidence  = prediction?.confidence ?? null;

    const pDef       = PROJECTS.find(p => p.key === forcedProject);
    project          = forcedProject;
    projectLabel     = pDef?.label ?? forcedProject;
    confidence       = 1.0;
    summary          = (text || url || '').slice(0, 120);
    suggested_action = 'Add to project';
    is_new_task      = true;
  } else {
    const routeInput = text || url;
    ({ project, projectLabel, confidence, summary, suggested_action, is_new_task } = await route(routeInput));
    modelProject     = project;
    modelConfidence  = confidence;
  }

  const projectDef = PROJECTS.find(p => p.key === project);
  const firstCol   = projectDef?.columns?.[0]?.key ?? 'backlog';

  // ── 2. Build a good item title ──────────────────────────────────────────────
  // For URL captures: fetch real page title. For text-only: use AI summary.
  let itemTitle    = null;
  let itemDesc     = null;   // one-liner shown on the Kanban card
  let itemSubtitle = extractSubtitle(text);

  if (url) {
    const meta = await fetchPageMeta(url);
    itemTitle = meta.title;
    // AI generates a factual one-liner, not meta marketing copy
    itemDesc  = await generateDescription(meta.title, meta.bodyText, url);
  }

  if (!itemTitle) {
    if (summary && summary !== (text || url || '').slice(0, 80)) {
      itemTitle = summary;
    } else if (url) {
      const slug = url.split('/').filter(Boolean).pop()?.replace(/[-_]/g, ' ') ?? '';
      const host = new URL(url).hostname.replace('www.', '');
      itemTitle = slug ? `${slug} — ${host}` : host;
    } else if (text) {
      // For text-only: use AI to extract a clean short title (event/org name etc.)
      try {
        const result = await chatWithModel('gemini-flash', {
          system:   'Extract the name of the event, program, or topic from this text. Return only the name — no explanation, no punctuation at the end. Max 8 words.',
          messages: [{ role: 'user', content: text.slice(0, 600) }],
          maxTokens: 30,
        });
        logCost(result.modelKey, result.usage, { reason: 'title_extraction' }).catch(() => {});
        itemTitle = result.text?.trim().replace(/\.$/, '') || text.slice(0, 80);
      } catch {
        itemTitle = text.slice(0, 80);
      }
    } else {
      itemTitle = 'Untitled';
    }
  }

  // ── 3. Create a card ────────────────────────────────────────────────────────
  let itemId         = null;
  let appId          = null;
  let questionsCount = 0;
  let deadline       = null;
  let scrapeError    = null;

  const isGitHub = url && (url.includes('github.com') || url.includes('gitlab.com'));

  if (project === 'research_apps' && !isGitHub) {
    // research_apps always writes to applications table (never items).
    // With URL: scrape for questions + deadline.
    // Text-only: create a stub application from AI-extracted title.
    const scraped = url ? await scrapeApplication(url) : { error: 'no_url' };

    if (url && !scraped.error) {
      const { data: app, error: appErr } = await supabase
        .from('applications')
        .insert({
          name:          scraped.position || itemTitle || 'Untitled Application',
          org:           scraped.org      || 'Unknown',
          url,
          deadline:      scraped.deadline || null,
          status:        firstCol,
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
      // No URL or scrape failed — stub application row so it appears in the board
      scrapeError = url ? scraped.error : null;
      try {
        const { data: app } = await supabase
          .from('applications')
          .insert({
            name:        itemTitle.slice(0, 200),
            org:         'Unknown',
            url:         url ?? null,
            deadline:    null,
            status:      firstCol,
            project_key: project,
          })
          .select()
          .single();
        if (app) appId = app.id;
      } catch { /* non-fatal */ }
    }
  } else {
    // All other projects: items table
    try {
      const { data: item } = await supabase
        .from('items')
        .insert({
          project_key: project,
          title:       itemTitle.slice(0, 200),
          subtitle:    itemSubtitle,
          status:      firstCol,
          url:         url      ?? null,
          notes:       itemDesc ?? null,   // one-liner description for card
        })
        .select()
        .single();
      if (item) itemId = item.id;
    } catch { /* non-fatal */ }
  }

  // ── 4. Audit log (training signal) ─────────────────────────────────────────
  let logId = null;
  try {
    const { data: logRow } = await supabase
      .from('inbox_log')
      .insert({
        source:           source           ?? 'unknown',
        url:              url              ?? null,
        text:             text             ?? null,
        project,
        summary:          itemTitle        ?? summary,
        model_project:    modelProject,
        model_confidence: modelConfidence,
        final_project:    project,          // same as project unless corrected later
      })
      .select('id')
      .single();
    if (logRow) logId = logRow.id;
  } catch { /* non-fatal */ }

  return NextResponse.json({
    project,
    projectLabel,
    confidence,
    summary:          itemTitle     ?? summary,
    description:      itemDesc      ?? null,
    logId,            // returned so bot can reference for corrections
    modelProject,     // what router predicted (may differ from project if forced)
    suggested_action,
    is_new_task,
    itemId,
    appId,
    questionsCount,
    deadline,
    routedBy:    'router',
    routingCost: 0,
    source:      source ?? 'unknown',
    ...(scrapeError ? { scrapeError } : {}),
  });
}
