/**
 * POST /api/inbox/correct
 * Record a user correction on a previously logged inbox item.
 *
 * This is the primary mechanism for building a labelled training dataset.
 * Every row in inbox_log with corrected_project != null is a training example:
 *   input:     { url, text }          (what was sent)
 *   predicted: model_project          (what the router guessed)
 *   correct:   corrected_project      (what it should have been)
 *
 * Body: { logId, correctedProject, note? }
 */

import { NextResponse } from 'next/server';
import { supabase }     from '../../../../lib/supabase.js';
import { PROJECTS }     from '../../../../lib/projects.js';

export async function POST(req) {
  const { logId, correctedProject, note } = await req.json();

  if (!logId || !correctedProject) {
    return NextResponse.json({ error: 'logId and correctedProject required' }, { status: 400 });
  }

  const validKey = PROJECTS.find(p => p.key === correctedProject);
  if (!validKey) {
    return NextResponse.json({ error: `Unknown project key: ${correctedProject}` }, { status: 400 });
  }

  const { error } = await supabase
    .from('inbox_log')
    .update({
      corrected_project: correctedProject,
      correction_note:   note ?? null,
      is_correction:     true,
    })
    .eq('id', logId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, correctedProject });
}
