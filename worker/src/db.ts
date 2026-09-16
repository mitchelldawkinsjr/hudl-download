// Minimal pg client for the worker. Lazy pool (recreated if ended) so tests
// can isolate cleanly. Provides query + withTransaction + job-lease helpers
// using Postgres advisory locks (transaction-scoped, try-lock).
import pg from 'pg';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool || pool.ended) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgres://mitchelldawkins@localhost:5432/filmroom' });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
  tag?: string
): Promise<pg.QueryResult<T>> {
  const p = getPool();
  try {
    return await p.query<T>(text, params as unknown[]);
  } catch (err) {
    const e = err as Error & { code?: string };
    e.message = `[db${tag ? `.${tag}` : ''}] ${e.message}`;
    throw e;
  }
}

export async function withTransaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    let result: T;
    try {
      result = await fn(c);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    }
    return result;
  } finally {
    c.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool && !pool.ended) await pool.end();
  pool = null;
}

// Lease one due queued job using a transaction-scoped advisory lock. Returns
// the job row (with payload parsed) or null if none available. The lease is
// held for the transaction... but we need the lease to persist across the
// job's processing. So instead of a tx-scoped lock, we do an atomic UPDATE
// that flips queued→running and sets locked_at/locked_by/attempts, guarded by
// run_after and a lease-expiry check (rescue stale leases).
export interface JobRow {
  id: string;
  type: string;
  play_angle_id: string | null;
  status: string;
  run_after: Date;
  locked_at: Date | null;
  locked_by: string | null;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
  last_error: string | null;
}

export async function leaseDueJob(workerId: string, leaseMs: number): Promise<JobRow | null> {
  const now = Date.now();
  const staleBefore = new Date(now - leaseMs);
  const { rows } = await query<pg.QueryResultRow>(
    `update media_jobs set
       status = 'running',
       locked_at = now(),
       locked_by = $1,
       attempts = attempts + 1,
       updated_at = now()
     where id = (
       select id from media_jobs
       where status = 'queued'
         and run_after <= now()
         and attempts < max_attempts
       order by run_after
       for update skip locked
       limit 1
     )
     returning *`,
    [workerId],
    'job.lease'
  );
  // Also rescue stale running jobs (worker died) back to queued, once.
  await query(
    `update media_jobs set status = 'queued', locked_by = null, updated_at = now()
     where status = 'running' and locked_at < $1 and attempts < max_attempts`,
    [staleBefore],
    'job.rescue'
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id, type: r.type, play_angle_id: r.play_angle_id, status: r.status,
    run_after: r.run_after, locked_at: r.locked_at, locked_by: r.locked_by,
    attempts: r.attempts, max_attempts: r.max_attempts,
    payload: (typeof r.payload_json === 'string' ? JSON.parse(r.payload_json) : r.payload_json) || {},
    last_error: r.last_error,
  };
}
