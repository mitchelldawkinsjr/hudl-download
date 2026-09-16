// PostgreSQL client. One shared Pool per process; tests get an isolated
// schema/database via DATABASE_URL. The pool is recreated lazily if it has
// been ended (so tests that call closePool between cases get a fresh pool for
// the next case without re-importing the module). Exports a helper for
// running queries with structured logging of slow queries (no param values).
import pg from 'pg';
import { env, isTest } from '../config/env.js';

let _pool: pg.Pool | null = null;
function getPool(): pg.Pool {
  if (!_pool || (_pool as unknown as { ended?: boolean }).ended) {
    _pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: isTest ? 4 : 10,
      idleTimeoutMillis: 30_000,
    });
  }
  return _pool;
}

export interface QueryOptions {
  /** Tag for logs/tracing, e.g. 'games.list'. */
  tag: string;
}

/** Run a parameterized query. Args are passed to pg; never interpolated. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  opts: QueryOptions = { tag: 'query' }
): Promise<pg.QueryResult<T>> {
  const p = getPool();
  const start = Date.now();
  try {
    const res = await p.query<T>(text, params as unknown[]);
    const ms = Date.now() - start;
    if (ms > 200) {
      console.warn(`[db] slow query ${opts.tag} took ${ms}ms`);
    }
    return res;
  } catch (err) {
    const ms = Date.now() - start;
    console.error(`[db] error ${opts.tag} after ${ms}ms:`, err instanceof Error ? err.message : err);
    throw err;
  }
}

/** Run a function inside a single transaction. */
export async function withTransaction<T>(
  work: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
