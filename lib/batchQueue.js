/**
 * Batch API Queue — submit background jobs to Anthropic's Batch API at 50% cost.
 *
 * Batch-eligible tasks (user doesn't need the result immediately):
 *   - Summarizing saved articles
 *   - Draft application answers (deadline 7+ days out)
 *   - Study plans from saved resources
 *   - Morning briefings
 *
 * Jobs are stored in `batch_jobs` table and polled by the cron job.
 */

import { supabase } from './supabase.js';

const BATCH_API  = 'https://api.anthropic.com/v1/messages/batches';
const BATCH_MODEL = 'claude-sonnet-4-20250514'; // Sonnet at 50% = ~$1.50/$7.50 per 1M

// ── Submit ────────────────────────────────────────────────────────────────────

/**
 * Submit a batch of jobs to Anthropic and persist the batch ID.
 *
 * @param {Array<{ system: string, messages: object[], maxTokens?: number, meta?: object }>} jobs
 * @param {string} [projectKey]
 * @returns {Promise<string>} batchId
 */
export async function queueBatchJob(jobs, projectKey = null) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  const requests = jobs.map((job, i) => ({
    custom_id: `job-${i}-${Date.now()}`,
    params: {
      model:      BATCH_MODEL,
      max_tokens: job.maxTokens || 1500,
      system:     job.system,
      messages:   job.messages,
    },
  }));

  const res = await fetch(BATCH_API, {
    method:  'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ requests }),
  });

  if (!res.ok) throw new Error(`Batch submit failed: ${await res.text()}`);
  const data = await res.json();

  // Persist batch record
  try {
    await supabase.from('batch_jobs').insert({
      batch_id:     data.id,
      status:       data.processing_status,
      job_count:    jobs.length,
      project_key:  projectKey,
      metadata:     jobs.map(j => j.meta ?? null),
    });
  } catch (err) { console.error('[batchQueue:submit]', err.message); }

  return data.id;
}

// ── Poll ──────────────────────────────────────────────────────────────────────

/**
 * Check the status of a batch job.
 * When processing_status is 'ended', fetch results.
 *
 * @param {string} batchId
 * @returns {Promise<object>} Anthropic batch status object
 */
export async function checkBatchStatus(batchId) {
  const res = await fetch(`${BATCH_API}/${batchId}`, {
    headers: {
      'x-api-key':       process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!res.ok) throw new Error(`Batch check failed: ${await res.text()}`);
  return res.json();
}

/**
 * Fetch completed results for a finished batch.
 *
 * @param {string} batchId
 * @returns {Promise<Array>} Array of { custom_id, result: { type, message } }
 */
export async function getBatchResults(batchId) {
  const status = await checkBatchStatus(batchId);
  if (status.processing_status !== 'ended') {
    throw new Error(`Batch ${batchId} not finished (status: ${status.processing_status})`);
  }

  const res = await fetch(status.results_url, {
    headers: {
      'x-api-key':       process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
  });

  const text = await res.text();
  // Results are JSONL — one JSON object per line
  return text.trim().split('\n').map(line => JSON.parse(line));
}

// ── Poll pending batches (called by cron) ─────────────────────────────────────

/**
 * Check all pending batch_jobs in DB and update their status.
 * Returns array of newly completed batches with their results.
 */
export async function pollPendingBatches() {
  const { data: pending } = await supabase
    .from('batch_jobs')
    .select('*')
    .eq('status', 'in_progress');

  if (!pending?.length) return [];

  const completed = [];
  for (const job of pending) {
    try {
      const status = await checkBatchStatus(job.batch_id);
      await supabase.from('batch_jobs').update({ status: status.processing_status }).eq('id', job.id);
      if (status.processing_status === 'ended') {
        const results = await getBatchResults(job.batch_id);
        completed.push({ job, results });
      }
    } catch (err) {
      console.warn(`[Batch] Poll failed for ${job.batch_id}:`, err.message);
    }
  }

  return completed;
}
