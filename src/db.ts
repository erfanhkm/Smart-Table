// Postgres access. Real Postgres via DATABASE_URL, or in-memory pg-mem when
// PG_MEM=1 (used by tests/smoke so no docker is needed locally).
import { Pool, PoolClient } from 'pg';
import { newDb } from 'pg-mem';
import { config } from './config.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any = null;

function getPool(): Pool {
  if (pool) return pool as Pool;
  if (config.usePgMem) {
    const db = newDb();
    pool = new (db.adapters.createPg().Pool)();
  } else {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is not set (or run with PG_MEM=1 for in-memory DB)');
    }
    pool = new Pool({ connectionString: config.databaseUrl });
  }
  return pool as Pool;
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
  const res = await getPool().query(text, params as unknown[]);
  return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
}

export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
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
