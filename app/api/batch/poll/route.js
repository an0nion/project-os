/**
 * GET /api/batch/poll
 * Called by the Slack bot's 60s setInterval to check for completed batch jobs.
 * Runs pollPendingBatches(), extracts the result text and delivery target from each
 * completed job's metadata, marks the job as delivered, and returns the list.
 *
 * Returns: { completed: [{ text, channel, userId }] }
 */

import { NextResponse }        from 'next/server';
import { pollPendingBatches }  from '../../../../lib/batchQueue.js';
import { supabaseAdmin }       from '../../../../lib/supabase.js';

export async function GET(req) {
  const secret = req.headers.get('x-api-secret');
  if (!secret || secret !== process.env.APP_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const newlyCompleted = await pollPendingBatches();
  if (!newlyCompleted?.length) {
    return NextResponse.json({ completed: [] });
  }

  const db = supabaseAdmin();
  const completed = [];

  for (const { job, results } of newlyCompleted) {
    // Extract delivery info from the first job's metadata
    const meta = Array.isArray(job.metadata) ? job.metadata[0] : job.metadata;
    const deliveryChannel = meta?.deliveryChannel;
    const deliveryUserId  = meta?.deliveryUserId;

    if (!deliveryChannel) continue;

    // Concatenate all result texts (usually just one job per batch for draft use case)
    const texts = results
      .filter(r => r.result?.type === 'succeeded')
      .map(r => r.result.message?.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? '')
      .filter(Boolean);

    if (!texts.length) continue;

    const text = texts.join('\n\n---\n\n');

    // Mark as delivered so we don't re-deliver on next poll
    try {
      await db.from('batch_jobs').update({ status: 'delivered' }).eq('id', job.id);
    } catch (err) {
      console.error('[batch:poll] failed to mark delivered:', err.message);
    }

    completed.push({ text, channel: deliveryChannel, userId: deliveryUserId });
  }

  return NextResponse.json({ completed });
}
