/**
 * GET /api/projects
 * Returns all project definitions (static config, not DB rows).
 * Used by the QA test matrix and the dashboard.
 */

import { NextResponse }    from 'next/server';
import { PROJECTS, GROUPS } from '../../../lib/projects.js';

export async function GET() {
  return NextResponse.json({ projects: PROJECTS, groups: GROUPS });
}
