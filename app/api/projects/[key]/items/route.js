/**
 * GET  /api/projects/:key/items
 *   Returns items grouped by column status.
 *   - research_apps: reads from applications table (has questions/org/deadline)
 *   - all others:    reads from items table
 *
 * Response: { columns, grouped: { [statusKey]: item[] } }
 *
 * Unified item shape:
 *   { id, title, subtitle, status, due_date, url, notes, extra? }
 */

import { NextResponse } from 'next/server';
import { selectFrom }   from '../../../../../lib/supabaseQuery.js';
import { PROJECTS }     from '../../../../../lib/projects.js';

export async function GET(req, { params }) {
  const { key } = params;

  const projectDef = PROJECTS.find(p => p.key === key);
  if (!projectDef) {
    return NextResponse.json({ error: 'Unknown project' }, { status: 404 });
  }

  const columns = projectDef.columns ?? [];

  let items = [];

  if (key === 'research_apps') {
    // Map applications → unified item shape
    const { data, error } = await selectFrom('applications', {
      columns: 'id, name, org, status, deadline, url, questions(id, text, status, answer)',
    })
      .eq('project_key', key)
      .order('deadline', { ascending: true, nullsFirst: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    items = (data ?? []).map(a => ({
      id:       a.id,
      title:    a.name,
      subtitle: a.org,
      status:   a.status === 'backlog' ? 'backlog' : a.status,
      due_date: a.deadline,
      url:      a.url,
      notes:    null,
      // Filter out soft-deleted child questions (Supabase nested selects don't
      // honour the parent's deleted_at filter).
      extra:    { questions: (a.questions ?? []).filter(q => q.deleted_at == null) },
    }));
  } else {
    const { data, error } = await selectFrom('items')
      .eq('project_key', key)
      .order('position', { ascending: true })
      .order('created_at', { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    items = data ?? [];
  }

  // Group by column status
  const grouped = {};
  for (const col of columns) grouped[col.key] = [];
  const firstColKey = columns[0]?.key ?? 'backlog';

  for (const item of items) {
    const colKey = columns.find(c => c.key === item.status) ? item.status : firstColKey;
    grouped[colKey].push(item);
  }

  return NextResponse.json({ columns, grouped });
}
