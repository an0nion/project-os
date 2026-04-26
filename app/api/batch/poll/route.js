/**
 * GET /api/batch/poll
 * Called by the Slack bot's 60s setInterval to check for completed batch jobs.
 * Runs pollPendingBatches(), extracts the result text and delivery target from each
 * completed job's metadata, marks the job as delivered, and returns the list.
 *
 * Returns: { completed: [{ text, channel, userId }] }
 */

import { pollPendingBatches }  from '../../../../lib/batchQueue.js';
import { supabaseAdmin }       from '../../../../lib/supabase.js';
import { ok, fail }            from '../../../../lib/apiResponse.js';
import { AuthError }           from '../../../../lib/errors.js';
import { log }                 from '../../../../lib/log.js';

export async function GET(req) {
  try {
    const secret = req.headers.get('x-api-secret');
    if (!secret || secret !== process.env.APP_SECRET) {
      throw new AuthError();
    }

    const newlyCompleted = await pollPendingBatches();
    if (!newlyCompleted?.length) {
      return ok({ completed: [] });
    }

    const db = supabaseAdmin();
    const completed = [];

    for (const { job, results } of newlyCompleted) {
      const meta = Array.isArray(job.metadata) ? job.metadata[0] : job.metadata;
      const deliveryChannel = meta?.deliveryChannel;
      const deliveryUserId  = meta?.deliveryUserId;

      if (!deliveryChannel) continue;

      const texts = results
        .filter(r => r.result?.type === 'succeeded')
        .map(r => r.result.message?.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? '')
        .filter(Boolean);

      if (!texts.length) continue;

      const text = texts.join('\n\n---\n\n');

      try {
        await db.from('batch_jobs').update({ status: 'delivered' }).eq('id', job.id);
      } catch (e) {
        log.warn('batch:poll', 'mark_delivered_failed', { err: e.message });
      }

      completed.push({ text, channel: deliveryChannel, userId: deliveryUserId });
    }

    return ok({ completed });
  } catch (err) {
    log.error('batch:poll', 'failed', { err: err.message });
    return fail(err);
  }
}
