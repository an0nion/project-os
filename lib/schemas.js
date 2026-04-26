/**
 * Zod schemas for every API request body.
 *
 * Routes do:
 *
 *   import { ScrapePost } from '../../../lib/schemas.js';
 *   const parsed = ScrapePost.safeParse(body);
 *   if (!parsed.success) throw new ValidationError('Bad request', parsed.error.format());
 *   const { url, projectKey } = parsed.data;
 *
 * Schema names follow the convention <Resource><Method> (e.g. InboxPost,
 * ItemPatch). Query-param schemas use the suffix Query (e.g. CostsQuery).
 *
 * Project keys are validated against the live PROJECTS list.
 */

import { z } from 'zod';
import { PROJECTS } from './projects.js';

const PROJECT_KEYS = PROJECTS.map(p => p.key);
export const ProjectKey = z.enum(PROJECT_KEYS);

// Common reusable shapes
const NonEmptyString = z.string().min(1);

// ── /api/inbox POST ──────────────────────────────────────────────────────────
// Universal capture — needs url OR text; project is optional (forced project key).
export const InboxPost = z.object({
  url:           z.string().url().optional(),
  text:          z.string().optional(),
  source:        z.string().optional(),
  project:       ProjectKey.optional(),
  priority_tier: z.number().int().min(1).max(3).optional(),
  timeline:      z.string().optional(),
  title:         z.string().optional(),
}).refine(d => d.url || d.text, { message: 'url or text required' });

// ── /api/inbox/correct POST ──────────────────────────────────────────────────
export const InboxCorrectPost = z.object({
  logId:            z.union([z.string(), z.number()]),
  correctedProject: ProjectKey,
  note:             z.string().optional(),
});

// ── /api/inbox/search GET (query params) ─────────────────────────────────────
export const InboxSearchQuery = z.object({
  q:     NonEmptyString,
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

// ── /api/scrape POST ─────────────────────────────────────────────────────────
export const ScrapePost = z.object({
  url:        z.string().url(),
  projectKey: ProjectKey.default('research_apps'),
});

// ── /api/items/:id PATCH ─────────────────────────────────────────────────────
export const ItemPatch = z.object({
  title:    z.string().optional(),
  subtitle: z.string().optional(),
  status:   z.string().optional(),
  due_date: z.string().nullable().optional(),
  url:      z.string().nullable().optional(),
  notes:    z.string().nullable().optional(),
  position: z.number().optional(),
  // Used when the row falls back to the applications table.
  deadline: z.string().nullable().optional(),
  name:     z.string().optional(),
  org:      z.string().optional(),
}).passthrough();

// ── /api/applications POST ───────────────────────────────────────────────────
export const ApplicationPost = z.object({
  name:       NonEmptyString,
  org:        z.string().optional(),
  url:        z.string().url().optional().nullable(),
  deadline:   z.string().optional().nullable(),
  projectKey: ProjectKey.default('research_apps'),
});

// ── /api/applications/:id PATCH ──────────────────────────────────────────────
export const ApplicationPatch = z.object({
  name:        z.string().optional(),
  org:         z.string().optional(),
  url:         z.string().nullable().optional(),
  deadline:    z.string().nullable().optional(),
  status:      z.string().optional(),
  project_key: ProjectKey.optional(),
}).passthrough();

// ── /api/calendar/event POST ─────────────────────────────────────────────────
// colorId 1-11 per Google Calendar spec.
export const CalendarEventPost = z.object({
  title:           NonEmptyString,
  date:            NonEmptyString, // YYYY-MM-DD or ISO datetime
  colorId:         z.union([
                     z.number().int().min(1).max(11),
                     z.string().regex(/^([1-9]|1[01])$/),
                   ]).optional(),
  description:     z.string().optional(),
  durationMinutes: z.number().int().positive().max(480).optional(),
  reminderMinutes: z.array(z.number().int().min(0).max(10080)).max(5).optional(),
  inbox_id:        z.union([z.string(), z.number()]).optional(),
});

// ── /api/batch/submit POST ───────────────────────────────────────────────────
const BatchJob = z.object({
  system:    z.string().optional(),
  messages:  z.array(z.object({
    role:    z.enum(['user', 'assistant', 'system']),
    content: z.string(),
  })).min(1),
  maxTokens: z.number().int().positive().optional(),
}).passthrough();

export const BatchSubmitPost = z.object({
  jobs:            z.array(BatchJob).min(1),
  projectKey:      ProjectKey.optional().nullable(),
  deliveryUserId:  NonEmptyString,
  deliveryChannel: NonEmptyString,
});

// ── /api/tasks/:id PATCH ─────────────────────────────────────────────────────
export const TasksPatch = z.object({
  answer:         z.string().optional(),
  status:         z.string().optional(),
  category:       z.string().optional(),
  base_answer_id: z.union([z.string(), z.number()]).nullable().optional(),
}).passthrough();

// ── /api/preferences POST ────────────────────────────────────────────────────
export const PreferencesPost = z.object({
  duration_minutes: z.number().int().positive().max(480).optional(),
  reminder_minutes: z.array(z.number().int().min(0).max(10080)).optional(),
  default_notes:    z.string().max(500).optional(),
  setup_complete:   z.boolean().optional(),
}).passthrough();

// ── /api/parse-questions POST ────────────────────────────────────────────────
export const ParseQuestionsPost = z.object({
  text:  NonEmptyString,
  appId: z.union([z.string(), z.number()]).optional(),
  useAi: z.boolean().optional(),
});

// ── /api/base-answers POST ───────────────────────────────────────────────────
export const BaseAnswerPost = z.object({
  category: NonEmptyString,
  content:  z.string(),
});

// ── /api/base-answers/:category PUT ──────────────────────────────────────────
export const BaseAnswerPut = z.object({
  content: z.string(),
});

// ── /api/chat POST ───────────────────────────────────────────────────────────
const ChatMessage = z.object({
  role:    z.enum(['user', 'assistant', 'system']),
  content: z.string(),
});

export const ChatPost = z.union([
  // Flat format
  z.object({
    message:             z.string(),
    projectKey:          ProjectKey.optional().nullable(),
    appId:               z.union([z.string(), z.number()]).optional().nullable(),
    questionId:          z.union([z.string(), z.number()]).optional().nullable(),
    isEscalated:         z.boolean().optional(),
    conversationHistory: z.array(ChatMessage).optional(),
  }),
  // Array format
  z.object({
    messages:    z.array(ChatMessage).min(1),
    projectKey:  ProjectKey.optional().nullable(),
    appId:       z.union([z.string(), z.number()]).optional().nullable(),
    questionId:  z.union([z.string(), z.number()]).optional().nullable(),
    isEscalated: z.boolean().optional(),
  }),
]);

// ── /api/costs/log POST ──────────────────────────────────────────────────────
export const CostsLogPost = z.object({
  modelKey: NonEmptyString,
  usage:    z.object({
    input_tokens:  z.number().optional(),
    output_tokens: z.number().optional(),
  }).passthrough(),
  reason:     z.string().optional(),
  projectKey: ProjectKey.optional().nullable(),
});

// ── /api/costs GET (query) ───────────────────────────────────────────────────
export const CostsQuery = z.object({
  period: z.enum(['today', 'week', 'month']).default('month'),
});

// ── /api/counters POST (increment/reset) ─────────────────────────────────────
export const CountersPost = z.object({
  key:   NonEmptyString.optional(),
  name:  NonEmptyString.optional(),   // legacy alias for `key`
  delta: z.number().int().optional(), // atomic increment (Unit 4)
  count: z.number().int().optional(), // DEPRECATED overwrite path
  value: z.number().int().optional(), // /reset path
  meta:  z.unknown().optional(),
}).refine(d => d.key || d.name, { message: 'key (or legacy `name`) required' });

// ── /api/sessions POST ───────────────────────────────────────────────────────
export const SessionsPost = z.object({
  userId:     NonEmptyString,
  state:      z.unknown().refine(v => v != null, { message: 'state required' }),
  ttlSeconds: z.number().int().positive().optional(),
});

// ── /api/push/subscribe POST ─────────────────────────────────────────────────
export const PushSubscribePost = z.object({
  endpoint: NonEmptyString,
  keys:     z.object({
    auth:   z.string(),
    p256dh: z.string(),
  }).optional(),
}).passthrough();
