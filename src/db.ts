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
  return new Pool({ connectionString: config.databaseUrl });
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
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
