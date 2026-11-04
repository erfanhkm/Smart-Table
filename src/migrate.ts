// Applies migrations/*.sql in filename order, tracking state in schema_migrations.
// Statements are executed one at a time so the runner works on both real
// Postgres and pg-mem. Each file applies inside ONE transaction together
// with its schema_migrations row (v0.10.4, C3-5-1): a mid-file failure
// rolls the whole file back instead of leaving a partial apply that
// crash-loops every later boot.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, withAdvisoryLock, withTx } from './db.js';
import { config } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Split a migration file into individual statements. The old splitter cut
 * on every `;` + newline, which mis-splits semicolons inside string
 * literals and dollar-quoted bodies (v0.10.4, C3-5-1). This scanner tracks
 * single-quoted strings (with '' escapes) and dollar-quote tags, and only
 * splits on a top-level semicolon. Full-line `--` comments are stripped
 * first, as before.
 */
export function splitStatements(sql: string): string[] {
  const cleaned = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const out: string[] = [];
  let cur = '';
  let i = 0;
  let inSingle = false;
  let dollarTag: string | null = null;
  const push = () => {
    const s = cur.trim();
    if (s) out.push(s);
    cur = '';
  };
  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (dollarTag !== null) {
      if (cleaned.startsWith(dollarTag, i)) {
        cur += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        cur += ch;
        i += 1;
      }
      continue;
    }
    if (inSingle) {
      cur += ch;
      if (ch === "'") {
        if (cleaned[i + 1] === "'") {
          cur += "'";
          i += 2;
          continue;
        }
        inSingle = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(cleaned.slice(i));
      if (m) {
        dollarTag = m[0];
        cur += m[0];
        i += m[0].length;
        continue;
      }
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === ';') {
      push();
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  push();
  return out;
}

export async function migrate(migrationsDir = path.join(here, '..', 'migrations')): Promise<void> {
  // F-11: serialize migrations across instances with an advisory lock so
  // two booting instances can't apply the same file concurrently. The lock
  // is held for the whole run. pg-mem has no advisory locks — there the
  // probe throws and we proceed unlocked (tests are single-instance).
  // v0.10.4 (C3-5-1): the probe's catch-all used to treat ANY error as
  // "locks unsupported", so a transient production DB error silently
  // disabled the serialization and migrated unlocked. Only pg-mem may take
  // the unlocked path; any other probe failure rethrows and the boot fails
  // loudly instead of racing another instance.
  let lockSupported = true;
  try {
    await withAdvisoryLock('smart-table-migrate-probe', async () => undefined);
  } catch (e) {
    if (!config.usePgMem) throw e;
    lockSupported = false;
  }
  if (!lockSupported) {
    await migrateUnlocked(migrationsDir);
    return;
  }
  const done = await withAdvisoryLock('smart-table-migrate', () => migrateUnlocked(migrationsDir));
  if (done === null) {
    // Another instance is migrating right now: wait for it, then re-check
    // (schema_migrations makes the second pass a no-op for applied files).
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const retry = await withAdvisoryLock('smart-table-migrate', () => migrateUnlocked(migrationsDir));
      if (retry !== null) return;
    }
    // v0.10.4 (C3-5-1): never fall through to an unlocked run when the lock
    // stays held. Two instances applying the same file concurrently is
    // worse than a refused boot — the deploy retries, while a half-applied
    // concurrent migration does not un-happen.
    throw new Error(
      'migrations: another instance still holds the migration lock after 10s — refusing to run unlocked',
    );
  }
}

async function migrateUnlocked(migrationsDir: string): Promise<void> {
  // v0.10.4 (C3-5-1): existence check first, CREATE only when absent.
  // `CREATE TABLE IF NOT EXISTS` against an existing table trips a pg-mem
  // planner limitation (unread AST on the DEFAULT now() expression), which
  // made every SECOND migrate() call in a process fail under pg-mem; the
  // check-then-create form is idempotent on both engines.
  const existing = await query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'`,
  );
  if (existing.rowCount === 0) {
    await query(`CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  }
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const done = await query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [file]);
    if (done.rowCount > 0) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    const statements = splitStatements(sql);
    // v0.10.4 (C3-5-1): one transaction per file, with the bookkeeping
    // insert inside the same transaction. On real Postgres, SET LOCAL
    // widens the pool-wide 15s statement / 10s lock timeouts for this
    // transaction only, so a larger DDL file cannot fail the boot against
    // limits sized for request queries.
    await withTx(async (client) => {
      if (!config.usePgMem) {
        await client.query(`SET LOCAL statement_timeout = '120s'`);
        await client.query(`SET LOCAL lock_timeout = '30s'`);
      }
      for (const stmt of statements) {
        await client.query(stmt);
      }
      await client.query(`INSERT INTO schema_migrations(name) VALUES ($1)`, [file]);
    });
    console.log(`[migrate] applied ${file}`);
  }
}
