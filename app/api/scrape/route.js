/**
 * POST /api/scrape
 * Scrape a URL and save the resulting application + questions to the DB.
 *
 * Body: { url, projectKey? }
 * Response: scrape result + appId
 */

import { NextResponse }       from 'next/server';
import { scrapeApplication }  from '../../../scraper/index.js';
import { supabase }           from '../../../lib/supabase.js';

export async function POST(req) {
  const { url, projectKey = 'research_apps' } = await req.json();
  if (!url) return NextResponse.json({ error: 'URL required' }, { status: 400 });

  const result = await scrapeApplication(url);

  // Return scrape errors to the client — don't 500
  if (result.error) {
    return NextResponse.json(result);
  }

  // Persist application
  const { data: app, error: appErr } = await supabase
    .from('applications')
    .insert({
      name:          result.position || 'Untitled Application',
      org:           result.org      || 'Unknown',
      url,
      deadline:      result.deadline || null,
      status:        'backlog',
      project_key:   projectKey,
      scrape_method: result.method,
    })
    .select()
    .single();

  if (appErr) return NextResponse.json({ error: appErr.message }, { status: 500 });

  // Persist questions
  if (result.questions?.length) {
    await supabase.from('questions').insert(
      result.questions.map(q => ({
        application_id: app.id,
        text:           q.text,
        category:       q.category,
        answer:         '',
        status:         'pending',
      })),
    );
  }

  return NextResponse.json({ ...result, appId: app.id });
}
