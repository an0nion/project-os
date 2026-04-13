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

import { NextResponse }   from 'next/server';
import { queueBatchJob }  from '../../../../lib/batchQueue.js';

export async function POST(req) {
  const secret = req.headers.get('x-api-secret');
  if (!secret || secret !== process.env.APP_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { jobs, projectKey, deliveryUserId, deliveryChannel } = await req.json();
  if (!jobs?.length || !deliveryUserId || !deliveryChannel) {
    return NextResponse.json({ error: 'jobs, deliveryUserId, and deliveryChannel required' }, { status: 400 });
  }

  // Embed delivery info in each job's meta so the poll endpoint can retrieve it
  const jobsWithMeta = jobs.map(j => ({
    ...j,
    meta: { deliveryUserId, deliveryChannel },
  }));

  const batchId = await queueBatchJob(jobsWithMeta, projectKey ?? null);
  return NextResponse.json({ batchId });
}
