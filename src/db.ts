// Postgres access. Real Postgres via DATABASE_URL, or in-memory pg-mem when
// PG_MEM=1 (used by tests/smoke so no docker is needed locally).
// pg-mem is a devDependency: it is imported lazily, only on the PG_MEM path, so a
// production image installed with `npm ci --omit=dev` never needs it.
import { Pool, PoolClient } from 'pg';
import { config } from './config.js';

let poolPromise: Promise<Pool> | null = null;

async function createPool(): Promise<Pool> {
  if (config.usePgMem) {
    if (config.isProd) throw new Error('PG_MEM=1 is not allowed when NODE_ENV=production');
    const { newDb } = await import('pg-mem');
    const db = newDb();
    return new (db.adapters.createPg().Pool)() as unknown as Pool;
  }
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set (or run with PG_MEM=1 for in-memory DB)');
  }
  // F-3: explicit pool + server-side session timeouts. A wedged query or a
  // transaction left open by a crashed request must never hold locks (or
  // pool connections) forever: statements die at 15s, lock waits at 5s,
  // idle-in-transaction sessions at 20s.
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    options: '-c statement_timeout=15000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=20000',
  });
}

function getPool(): Promise<Pool> {
  if (!poolPromise) poolPromise = createPool();
  return poolPromise;
}

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/** `SELECT ... FOR UPDATE` is not implemented by pg-mem (used in tests). */
export function forUpdate(): string {
  return config.usePgMem ? '' : ' FOR UPDATE';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
  const pool = await getPool();
  const res = await pool.query(text, params as unknown[]);
  return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
}

export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    // F-11: a failed ROLLBACK must never mask the original error.
    await client.query('ROLLBACK').catch((rbErr) => {
      console.error('[db] ROLLBACK failed (original error preserved):', rbErr);
    });
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Run fn while holding a session-level Postgres advisory lock on a
 * dedicated connection. Returns null when the lock is already held
 * (try-lock semantics) so callers can skip overlapping work. Used by
 * migrations (F-11), the reconciler (F-6) and refunds (F-9).
 *
 * pg-mem has no advisory locks (nor hashtext): with runIfUnsupported the
 * lock ACQUISITION failure runs fn unlocked instead of throwing. fn's
 * own errors always propagate — they are never mistaken for a lock
 * failure and fn never runs twice.
 */
export async function withAdvisoryLock<T>(
  name: string,
  fn: () => Promise<T>,
  opts: { runIfUnsupported?: boolean } = {},
): Promise<T | null> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    let locked: boolean;
    try {
      const res = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
        [name],
      );
      locked = !!res.rows[0]?.locked;
    } catch (e) {
      if (opts.runIfUnsupported) return await fn();
      throw e;
    }
    if (!locked) return null;
    try {
      return await fn();
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [name]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}
