// Health routes. Liveness is dependency-free; readiness checks the database
// and reports worker heartbeats (Phase 7). A worker is "stale" if its last
// heartbeat is older than WORKER_STALE_MS (default 3× poll interval), and
// "dead" if older than WORKER_DEAD_MS (default 60s). Readiness still returns
// 503 only when the DB is down; stale/dead workers are reported but do not
// by themselves fail readiness (a single worker may be mid-restart).
import { Router } from 'express';
import { query } from '../db/client.js';

export const healthRouter = Router();

const WORKER_STALE_MS = Number(process.env.WORKER_STALE_MS) || 15_000;
const WORKER_DEAD_MS = Number(process.env.WORKER_DEAD_MS) || 60_000;

healthRouter.get('/live', (_req, res) => {
  res.json({ status: 'ok' });
});

healthRouter.get('/ready', async (_req, res) => {
  try {
    const r = await query('select 1 as ok', [], { tag: 'health.ready' });
    if (r.rows[0]?.ok !== 1) {
      res.status(503).json({ status: 'not_ready', deps: { db: 'fail' } });
      return;
    }
    let workers: { id: string; status: string; lastSeenAt: string; ageMs: number; state: string }[] = [];
    try {
      const wb = await query(
        `select worker_id as id, status, last_seen_at, extract(epoch from (now() - last_seen_at)) * 1000 as age_ms
         from worker_heartbeats order by last_seen_at desc`,
        [], { tag: 'health.workers' }
      );
      workers = wb.rows.map((w: any) => ({
        id: w.id, status: w.status, lastSeenAt: w.last_seen_at, ageMs: Math.round(w.age_ms),
        state: w.age_ms > WORKER_DEAD_MS ? 'dead' : w.age_ms > WORKER_STALE_MS ? 'stale' : 'live',
      }));
    } catch {
      // worker_heartbeats may not exist yet (pre-migration) — don't fail readiness.
    }
    res.json({ status: 'ready', deps: { db: 'ok' }, workers });
  } catch (err) {
    console.error('[health/ready] db error:', err instanceof Error ? err.message : err);
    res.status(503).json({ status: 'not_ready', deps: { db: 'fail' } });
  }
});
