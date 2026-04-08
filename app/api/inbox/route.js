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
 * Response: { project, projectLabel, confidence, summary, suggested_action,
 *             is_new_task, itemId?, appId?, questionsCount?, deadline?,
 *             routedBy, routingCost }
 */

import { NextResponse }      from 'next/server';
import { route }             from '../../../lib/router.js';
import { scrapeApplication } from '../../../scraper/index.js';
import { supabase }          from '../../../lib/supabase.js';
import { PROJECTS }          from '../../../lib/projects.js';

export async function POST(req) {
  const { url, text, source, project: forcedProject } = await req.json();

  if (!url && !text) {
    return NextResponse.json({ error: 'url or text required' }, { status: 400 });
  }

  // ── 1. Route to project ─────────────────────────────────────────────────────
  let project, projectLabel, confidence, summary, suggested_action, is_new_task;

  if (forcedProject) {
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
  }

  const projectDef = PROJECTS.find(p => p.key === project);
  const firstCol   = projectDef?.columns?.[0]?.key ?? 'backlog';

  // ── 2. Create a card ────────────────────────────────────────────────────────
  let itemId         = null;
  let appId          = null;
  let questionsCount = 0;
  let deadline       = null;
  let scrapeError    = null;

  const isGitHub = url && (url.includes('github.com') || url.includes('gitlab.com'));

  if (project === 'research_apps' && url && !isGitHub) {
    // research_apps: scrape URL → applications + questions tables
    const scraped = await scrapeApplication(url);

    if (!scraped.error) {
      const { data: app, error: appErr } = await supabase
        .from('applications')
        .insert({
          name:          scraped.position || summary || 'Untitled Application',
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
      scrapeError = scraped.error;
    }
  } else {
    // All other projects (or research_apps without URL): items table
    const title = summary || (url ? url.split('/').filter(Boolean).pop() : text?.slice(0, 80)) || 'Untitled';

    try {
      const { data: item } = await supabase
        .from('items')
        .insert({
          project_key: project,
          title:       title.slice(0, 200),
          subtitle:    null,
          status:      firstCol,
          url:         url ?? null,
          notes:       text && url ? text : null,   // keep original text as notes if we also have a url
        })
        .select()
        .single();
      if (item) itemId = item.id;
    } catch { /* non-fatal — item creation failure shouldn't break inbox */ }
  }

  // ── 3. Audit log ────────────────────────────────────────────────────────────
  try {
    await supabase.from('inbox_log').insert({
      source:  source  ?? 'unknown',
      url:     url     ?? null,
      text:    text    ?? null,
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
