// Retention cleanup (Phase 7). Deletes derived clip/thumbnail files whose
// play is older than the team's derived_retention_days, and prunes audit
// rows older than audit_retention_days. NEVER deletes media referenced by a
// non-deleted play (AC19): a play is only eligible once its mark_time is
// past the window AND its status is 'deleted' (soft-deleted) — live/ready
// plays are always retained. Continuous-recording pruning is the MediaMTX
// host's responsibility (it owns that store); Film Room only owns derived
// media under MEDIA_ROOT.
//
// Run as a cron job (e.g. daily). Dry-run by default; pass --apply to delete.
//
//   node --import tsx scripts/retention-cleanup.ts [--apply] [--team <id>]
import pg from 'pg';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://mitchelldawkins@localhost:5432/filmroom';
const MEDIA_ROOT = process.env.MEDIA_ROOT || './data/media';
const APPLY = process.argv.includes('--apply');
const teamIdx = process.argv.indexOf('--team');
const TEAM = teamIdx >= 0 ? process.argv[teamIdx + 1] : null;

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    // Default retention windows when no per-team override is set.
    const DEFAULT_DERIVED_DAYS = 30;
    const DEFAULT_AUDIT_DAYS = 365;

    // Eligible plays: soft-deleted plays whose mark_time is older than the
    // derived window. Non-deleted plays are never eligible (AC19).
    const teamFilter = TEAM ? 'and p.game_id in (select id from games where team_id = $2)' : '';
    const params: unknown[] = [DEFAULT_DERIVED_DAYS];
    if (TEAM) params.push(TEAM);

    const eligible = await client.query(
      `select p.id as play_id, g.team_id,
              coalesce(rs.derived_retention_days, $1) as retain_days
         from plays p join games g on g.id = p.game_id
         left join retention_settings rs on rs.team_id = g.team_id
        where p.status = 'deleted'
          and p.mark_time < now() - (coalesce(rs.derived_retention_days, $1) || ' days')::interval
          ${teamFilter}`,
      params
    );

    let deletedFiles = 0;
    let deletedAngles = 0;
    for (const row of eligible.rows) {
      const angles = await client.query(
        'select id, clip_uri, thumbnail_uri from play_angles where play_id = $1',
        [row.play_id]
      );
      for (const a of angles.rows) {
        for (const rel of [a.clip_uri, a.thumbnail_uri]) {
          if (!rel) continue;
          const full = resolvePath(MEDIA_ROOT, rel);
          if (!full.startsWith(resolvePath(MEDIA_ROOT))) continue; // path guard
          if (APPLY) {
            try { rmSync(full, { force: true }); } catch { /* ignore */ }
          }
          deletedFiles++;
        }
      }
      if (APPLY) {
        // Cascade removes play_angles + media_jobs + telestrations.
        await client.query('delete from plays where id = $1', [row.play_id]);
      }
      deletedAngles += angles.rowCount;
    }

    // Audit pruning.
    const auditParams: unknown[] = [DEFAULT_AUDIT_DAYS];
    if (TEAM) auditParams.push(TEAM);
    const audit = await client.query(
      `delete from audit_events
        where created_at < now() - ($1 || ' days')::interval
          ${TEAM ? "and actor_id in (select user_id from team_members where team_id = $2)" : ''}
        returning id`,
      auditParams
    );

    const mode = APPLY ? 'applied' : 'dry-run';
    console.log(JSON.stringify({
      mode, eligiblePlays: eligible.rowCount, deletedAngles, deletedFiles,
      prunedAudit: APPLY ? audit.rowCount : audit.rowCount,
    }));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error('retention-cleanup failed:', err); process.exit(1); });
