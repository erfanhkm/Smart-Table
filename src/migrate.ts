// Applies migrations/*.sql in filename order, tracking state in schema_migrations.
// Statements are executed one at a time (split on `;` + newline) so the runner
// works on both real Postgres and pg-mem.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function migrate(migrationsDir = path.join(here, '..', 'migrations')): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const done = await query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [file]);
    if (done.rowCount > 0) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    // Strip full-line comments, then split into single statements.
    const cleaned = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const statements = cleaned
      .split(/;\s*\n/)
      .map((s) => s.trim().replace(/;$/, ''))
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await query(stmt);
    }
    await query(`INSERT INTO schema_migrations(name) VALUES ($1)`, [file]);
    console.log(`[migrate] applied ${file}`);
  }
}
