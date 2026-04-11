/**
 * Migration runner — applies pending SQL migrations to Supabase in order.
 *
 * Usage:
 *   node scripts/migrate.js
 *
 * Requires in .env.local (or environment):
 *   SUPABASE_DB_URL  — Postgres connection string from Supabase dashboard
 *                      Settings → Database → Connection string (URI mode)
 *
 * Each migration file in scripts/migrations/ is named NNN_description.sql.
 * Applied versions are tracked in the schema_migrations table.
 * Migrations are idempotent — run twice is safe.
 */

import 'dotenv/config';
import fs     from 'node:fs';
import path   from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error('ERROR: SUPABASE_DB_URL is not set in .env.local');
    process.exit(1);
  }

  // Dynamic import so the package is only needed when running this script
  const { default: postgres } = await import('postgres');
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });

  try {
    // Step 1: Bootstrap the tracking table (must exist before anything else)
    await sql.unsafe(`
      create table if not exists schema_migrations (
        version    text primary key,
        applied_at timestamptz not null default now(),
        checksum   text
      )
    `);

    // Step 2: Read migration files sorted by numeric prefix
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    // Step 3: Get applied versions
    const rows    = await sql`select version from schema_migrations order by version`;
    const applied = new Set(rows.map(r => r.version));

    let appliedCount = 0;

    for (const file of files) {
      const version = file.split('_')[0];  // e.g. '007' from '007_bot_sessions.sql'

      if (applied.has(version)) {
        console.log(`  skip  ${file}`);
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const content  = fs.readFileSync(filePath, 'utf8');
      const checksum = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

      console.log(`  apply ${file} ...`);
      try {
        await sql.unsafe(content);
        await sql`
          insert into schema_migrations (version, checksum)
          values (${version}, ${checksum})
        `;
        console.log(`  done  ${file}`);
        appliedCount++;
      } catch (err) {
        console.error(`  FAIL  ${file}:`, err.message);
        process.exit(1);  // stop on first failure — migrations are sequential
      }
    }

    if (appliedCount === 0) {
      console.log('All migrations already applied — nothing to do.');
    } else {
      console.log(`\nApplied ${appliedCount} migration(s) successfully.`);
    }

  } finally {
    await sql.end();
  }
}

run().catch(err => {
  console.error('Migration runner failed:', err.message);
  process.exit(1);
});
