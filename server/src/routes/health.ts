// Health routes. Liveness is dependency-free; readiness checks the database.
import { Router } from 'express';
import { query } from '../db/client.js';

export const healthRouter = Router();

healthRouter.get('/live', (_req, res) => {
  res.json({ status: 'ok' });
});

healthRouter.get('/ready', async (_req, res) => {
  try {
    const r = await query('select 1 as ok', [], { tag: 'health.ready' });
    if (r.rows[0]?.ok === 1) {
      res.json({ status: 'ready', deps: { db: 'ok' } });
      return;
    }
    res.status(503).json({ status: 'not_ready', deps: { db: 'fail' } });
  } catch (err) {
    console.error('[health/ready] db error:', err instanceof Error ? err.message : err);
    res.status(503).json({ status: 'not_ready', deps: { db: 'fail' } });
  }
});
