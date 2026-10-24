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
  // pool connections) forever.
  // v0.8.6 (F5-3): idle-in-transaction raised 20s -> 60s — the payment path
  // holds a transaction across sequential POS calls (10s timeouts, up to 3
  // steps plus the no-fee retry), and a slow POS could idle past 20s, after
  // which Postgres killed the session mid-bookkeeping and stranded the
  // payment for reconcile. lock_timeout 5s -> 10s for the same reason:
  // simultaneous payers on one check queue on the check row lock, and a
  // wallet sheet on the first payer easily exceeds 5s (lock errors are also
  // mapped to a retryable 409 in the error handler). statement_timeout
  // stays 15s — request queries are all indexed point lookups; migrations
  // are small DDL files (a future data-backfill migration must be chunked).
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    options: '-c statement_timeout=15000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=60000',
  });
  // F5-2: pg.Pool emits 'error' when an IDLE client dies (DB restart,
  // failover, maintenance, network cut). With no listener Node treats it as
  // an unhandled error event and the whole process exits — one managed-
  // Postgres restart would take the API down for every tenant and abort
  // in-flight payments mid-bookkeeping. Log it; the pool discards the
  // dead client itself.
  pool.on('error', (err) => {
    console.error('[db] idle pool client error (client discarded):', err);
  });
  return pool;
}

/** Close the pool (graceful shutdown). Safe to call once at process exit. */
export async function closePool(): Promise<void> {
  if (!poolPromise) return;
  const pool = await poolPromise;
  poolPromise = null;
  await pool.end().catch(() => undefined);
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
  // F5-9: if ROLLBACK itself fails, the connection may still sit inside an
  // aborted transaction — releasing it normally would poison the next user
  // of that pooled client until the idle timeout. Release with the error
  // so the pool destroys the connection instead.
  let destroyClient: Error | undefined;
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    // F-11: a failed ROLLBACK must never mask the original error.
    await client.query('ROLLBACK').catch((rbErr) => {
      destroyClient = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
      console.error('[db] ROLLBACK failed (original error preserved):', rbErr);
    });
    throw e;
  } finally {
    client.release(destroyClient);
  }
}

/**
 * Run fn while holding a session-level Postgres advisory lock on a
 * dedicated connection. Returns null when the lock is already held
 * (try-lock semantics) so callers can skip overlapping work. Used by
 * migrations (F-11), the reconciler (F-6) and refunds (F-9).
 *
 * pg-mem has no advisory locks (nor hashtext): with runIfUnsupported the
 * lock ACQUISITION failure runs fn unlocked instead of throwing — but ONLY
 * in pg-mem mode (F5-4). In production a transient lock failure (statement
 * timeout, dropped connection) must surface, never silently disable the
 * protection for migrations / reconcile / refunds. fn's own errors always
 * propagate — they are never mistaken for a lock failure and fn never
 * runs twice.
 *
 * Lock keys use the 64-bit hashtextextended form on real Postgres (F5-4):
 * the 32-bit hashtext space collided across unrelated lock names. If the
 * unlock fails, the client is destroyed rather than returned to the pool
 * still holding a session-level lock (which would report "busy" to every
 * later caller until that backend closed).
 */
export async function withAdvisoryLock<T>(
  name: string,
  fn: () => Promise<T>,
  opts: { runIfUnsupported?: boolean } = {},
): Promise<T | null> {
  const pool = await getPool();
  const client = await pool.connect();
  const hashFn = config.usePgMem ? 'hashtext' : 'hashtextextended';
  const hashArg = config.usePgMem ? '$1' : '$1, 0';
  let destroyClient: Error | undefined;
  try {
    let locked: boolean;
    try {
      const res = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(${hashFn}(${hashArg})) AS locked`,
        [name],
      );
      locked = !!res.rows[0]?.locked;
    } catch (e) {
      if (opts.runIfUnsupported && config.usePgMem) return await fn();
      throw e;
    }
    if (!locked) return null;
    try {
      return await fn();
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${hashFn}(${hashArg}))`, [name]).catch((uErr) => {
        destroyClient = uErr instanceof Error ? uErr : new Error(String(uErr));
      });
    }
  } finally {
    client.release(destroyClient);
  }
}
