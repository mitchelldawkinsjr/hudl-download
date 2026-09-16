// Test-only reset endpoint. Available ONLY when NODE_ENV === 'test' (the E2E
// webServer sets it). Truncates all app tables and re-seeds an admin user +
// team so each E2E test starts from a clean slate. Never mounted in prod.
import { Router } from 'express';
import { withTransaction } from '../db/client.js';
import { asyncHandler } from '../middleware/error.js';
import argon2 from '@node-rs/argon2';

export const testResetRouter = Router();

testResetRouter.post(
  '/_test/reset',
  asyncHandler(async (_req, res) => {
    await withTransaction(async (c) => {
      for (const t of ['events', 'audit_events', 'telestrations', 'media_jobs', 'play_angles', 'plays',
        'game_sources', 'source_status_snapshots', 'sources', 'mediamtx_server_settings', 'games',
        'team_members', 'teams', 'users']) {
        await c.query(`truncate table ${t} cascade`);
      }
      const hash = await argon2.hash('admin-pass-1');
      const u = await c.query(
        `insert into users (email, display_name, password_hash, role) values ('admin@test.test','Admin',$1,'admin') returning id`,
        [hash]
      );
      const tm = await c.query(`insert into teams (name, slug) values ('Home Team','home') returning id`);
      await c.query('insert into team_members (user_id, team_id) values ($1,$2)', [u.rows[0].id, tm.rows[0].id]);
    });
    res.json({ data: { ok: true } });
  })
);
