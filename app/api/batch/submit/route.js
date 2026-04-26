/**
 * POST /api/batch/submit
 * VM-safe proxy — lets the Slack bot submit batch jobs without importing supabase
 * directly (which crashes on Oracle VM startup if SUPABASE_URL isn't in .env).
 *
 * Body: { jobs, projectKey?, deliveryUserId, deliveryChannel }
 *   jobs: [{ system, messages, maxTokens? }]
 *
 * Returns: { batchId }
 */

import { queueBatchJob }    from '../../../../lib/batchQueue.js';
import { ok, fail }         from '../../../../lib/apiResponse.js';
import { BatchSubmitPost }  from '../../../../lib/schemas.js';
import { ValidationError, AuthError } from '../../../../lib/errors.js';
import { log }              from '../../../../lib/log.js';

export async function POST(req) {
  try {
    const secret = req.headers.get('x-api-secret');
    if (!secret || secret !== process.env.APP_SECRET) {
      throw new AuthError();
    }

    let body;
    try { body = await req.json(); }
    catch { throw new ValidationError('Invalid JSON'); }

    const parsed = BatchSubmitPost.safeParse(body);
    if (!parsed.success) throw new ValidationError('Bad request', parsed.error.format());

    const { jobs, projectKey, deliveryUserId, deliveryChannel } = parsed.data;

    // Embed delivery info in each job's meta so the poll endpoint can retrieve it
    const jobsWithMeta = jobs.map(j => ({
      ...j,
      meta: { deliveryUserId, deliveryChannel },
    }));

    const batchId = await queueBatchJob(jobsWithMeta, projectKey ?? null);
    return ok({ batchId });
  } catch (err) {
    log.error('batch:submit', 'failed', { err: err.message });
    return fail(err);
  }
}
