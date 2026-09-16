// Worker heartbeat writer (Phase 7). Upserts a row in worker_heartbeats so
// the API readiness check and operators can see live vs stale workers.
import { query } from './db.js';

export interface Heartbeat {
  workerId: string;
  status: 'idle' | 'processing' | 'error';
  lastJobId?: string;
  lastError?: string;
}

export async function heartbeat(hb: Heartbeat): Promise<void> {
  await query(
    `insert into worker_heartbeats (worker_id, last_seen_at, status, last_job_id, last_error, updated_at)
     values ($1, now(), $2, $3, $4, now())
     on conflict (worker_id) do update
       set last_seen_at = now(),
           status = excluded.status,
           last_job_id = excluded.last_job_id,
           last_error = excluded.last_error,
           updated_at = now()`,
    [hb.workerId, hb.status, hb.lastJobId ?? null, hb.lastError ?? null],
    'worker.heartbeat'
  );
}
