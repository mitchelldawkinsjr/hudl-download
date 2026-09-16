// Sources routes: CRUD, publishing settings (masked), connection test.
// Sources are administrator-configured (ADR 0004). Each source has a display
// name, unique sanitized mediamtx_path, preview protocol, optional playback
// URL override, active toggle, sort order.
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/client.js';
import { audit } from '../services/audit.js';
import { asyncHandler, badRequest, notFound, forbidden } from '../middleware/error.js';
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/auth.js';
import { assertSafeUrl, validateServerUrl, SsrfError } from '../security/ssrf.js';

export const sourcesRouter = Router();

const pathRe = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const createSchema = z.object({
  teamId: z.string().uuid(),
  gameId: z.string().uuid().nullable().optional(),
  key: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/),
  displayName: z.string().min(1).max(80),
  mediamtxPath: z.string().min(2).max(80).regex(pathRe, 'must be lowercase, start/end alphanumeric, hyphens allowed'),
  previewProtocol: z.enum(['hls', 'webrtc']).default('hls'),
  playbackUrlOverride: z.string().url().nullable().optional(),
  sortOrder: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
});

const patchSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  mediamtxPath: z.string().min(2).max(80).regex(pathRe).optional(),
  previewProtocol: z.enum(['hls', 'webrtc']).optional(),
  playbackUrlOverride: z.string().url().nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

function rowToJson(r: Record<string, unknown>) {
  return {
    id: r.id,
    teamId: r.team_id,
    gameId: r.game_id,
    key: r.key,
    displayName: r.display_name,
    mediamtxPath: r.mediamtx_path,
    previewProtocol: r.preview_protocol,
    playbackUrlOverride: r.playback_url_override,
    sortOrder: r.sort_order,
    active: r.active,
  };
}

sourcesRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ar = req as AuthedRequest;
    const teamId = (req.query.teamId as string) || undefined;
    let sql = `select * from sources`;
    const params: unknown[] = [];
    if (ar.role !== 'admin') {
      sql += ` where team_id = any($1::uuid[])`;
      params.push(ar.teamIds);
      if (teamId) {
        sql += ` and team_id = $2`;
        params.push(teamId);
      }
    } else if (teamId) {
      sql += ` where team_id = $1`;
      params.push(teamId);
    }
    sql += ` order by sort_order, display_name`;
    const { rows } = await query(sql, params, { tag: 'sources.list' });
    res.json({ data: rows.map(rowToJson) });
  })
);

sourcesRouter.post(
  '/',
  requireAuth,
  requireRole('admin', 'operator'),
  asyncHandler(async (req, res) => {
    const parsed = createSchema.parse(req.body ?? {});
    const ar = req as AuthedRequest;
    if (ar.role !== 'admin' && !ar.teamIds.includes(parsed.teamId)) {
      throw forbidden('not a member of this team');
    }
    if (parsed.playbackUrlOverride) {
      try {
        validateServerUrl(parsed.playbackUrlOverride);
      } catch (e) {
        if (e instanceof SsrfError) throw badRequest(`invalid playbackUrlOverride: ${e.message}`);
        throw badRequest('invalid playbackUrlOverride');
      }
    }
    try {
      const { rows } = await query(
        `insert into sources
           (team_id, game_id, key, display_name, mediamtx_path, preview_protocol,
            playback_url_override, sort_order, active)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [
          parsed.teamId, parsed.gameId ?? null, parsed.key, parsed.displayName,
          parsed.mediamtxPath, parsed.previewProtocol, parsed.playbackUrlOverride ?? null,
          parsed.sortOrder, parsed.active,
        ],
        { tag: 'sources.create' }
      );
      await audit({ actorId: ar.userId, action: 'source.create', entityType: 'source', entityId: rows[0].id, after: parsed, requestId: res.locals.requestId });
      res.status(201).json({ data: rowToJson(rows[0]) });
    } catch (err) {
      if (err instanceof Error && /unique/i.test(err.message)) {
        throw badRequest('a source with that mediamtx path already exists for this team');
      }
      throw err;
    }
  })
);

sourcesRouter.patch(
  '/:id',
  requireAuth,
  requireRole('admin', 'operator'),
  asyncHandler(async (req, res) => {
    const parsed = patchSchema.parse(req.body ?? {});
    const ar = req as AuthedRequest;
    const { rows } = await query('select * from sources where id = $1', [req.params.id], { tag: 'sources.get' });
    const existing = rows[0];
    if (!existing) throw notFound('source');
    if (ar.role !== 'admin' && !ar.teamIds.includes(existing.team_id)) {
      throw forbidden('not a member of this team');
    }
    if (parsed.playbackUrlOverride) {
      try {
        validateServerUrl(parsed.playbackUrlOverride);
      } catch (e) {
        if (e instanceof SsrfError) throw badRequest(`invalid playbackUrlOverride: ${e.message}`);
        throw badRequest('invalid playbackUrlOverride');
      }
    }
    try {
      const r = await query(
        `update sources set
           display_name = coalesce($1, display_name),
           mediamtx_path = coalesce($2, mediamtx_path),
           preview_protocol = coalesce($3, preview_protocol),
           playback_url_override = $4,
           sort_order = coalesce($5, sort_order),
           active = coalesce($6, active)
         where id = $7 returning *`,
        [
          parsed.displayName ?? null, parsed.mediamtxPath ?? null, parsed.previewProtocol ?? null,
          parsed.playbackUrlOverride !== undefined ? parsed.playbackUrlOverride : null,
          parsed.sortOrder ?? null, parsed.active ?? null, req.params.id,
        ],
        { tag: 'sources.update' }
      );
      await audit({ actorId: ar.userId, action: 'source.update', entityType: 'source', entityId: req.params.id, before: rowToJson(existing), after: rowToJson(r.rows[0]), requestId: res.locals.requestId });
      res.json({ data: rowToJson(r.rows[0]) });
    } catch (err) {
      if (err instanceof Error && /unique/i.test(err.message)) {
        throw badRequest('a source with that mediamtx path already exists for this team');
      }
      throw err;
    }
  })
);

sourcesRouter.delete(
  '/:id',
  requireAuth,
  requireRole('admin', 'operator'),
  asyncHandler(async (req, res) => {
    const ar = req as AuthedRequest;
    const { rows } = await query('select * from sources where id = $1', [req.params.id], { tag: 'sources.get' });
    const existing = rows[0];
    if (!existing) throw notFound('source');
    if (ar.role !== 'admin' && !ar.teamIds.includes(existing.team_id)) {
      throw forbidden('not a member of this team');
    }
    await query('delete from sources where id = $1', [req.params.id], { tag: 'sources.delete' });
    await audit({ actorId: ar.userId, action: 'source.delete', entityType: 'source', entityId: req.params.id, before: rowToJson(existing), requestId: res.locals.requestId });
    res.json({ data: { ok: true } });
  })
);

// Build the publishing settings a device operator copies into OBS/DJI:
// separate server URL + stream key, plus a combined URL. The stream key is
// the source's mediamtx_path (per the /games/{gameUuid}/{path} convention).
// Returned to authorized users only; the UI masks the key by default.
function buildPublishing(source: Record<string, unknown>, server: Record<string, unknown> | null, gameId: string | null) {
  const rtmpHost = (server?.rtmp_host as string) || process.env.MEDIAMTX_RTMP_HOST || 'localhost';
  const rtmpPort = (server?.rtmp_port as number) || Number(process.env.MEDIAMTX_RTMP_PORT) || 1935;
  const path = source.mediamtx_path as string;
  // Per-game path when a game is open; otherwise the bare source path.
  const streamKey = gameId ? `games/${gameId}/${path}` : path;
  const serverUrl = `rtmp://${rtmpHost}:${rtmpPort}`;
  const combinedUrl = `${serverUrl}/${streamKey}`;
  return {
    serverUrl,
    streamKey,
    combinedUrl,
    maskedStreamKey: streamKey.slice(0, 4) + '••••' + streamKey.slice(-2),
  rtmpHost,
    rtmpPort,
  };
}

sourcesRouter.get(
  '/:id/publishing',
  requireAuth,
  requireRole('admin', 'operator'),
  asyncHandler(async (req, res) => {
    const ar = req as AuthedRequest;
    const { rows } = await query('select * from sources where id = $1', [req.params.id], { tag: 'sources.get' });
    const source = rows[0];
    if (!source) throw notFound('source');
    if (ar.role !== 'admin' && !ar.teamIds.includes(source.team_id)) {
      throw forbidden('not a member of this team');
    }
    const s = await query('select * from mediamtx_server_settings where team_id is null limit 1', [], { tag: 'settings.get' });
    const gameId = (req.query.gameId as string) || (source.game_id as string) || null;
    res.json({ data: buildPublishing(source, s.rows[0] || null, gameId) });
  })
);

// Server-side connection test. Hits the external MediaMTX Control API for the
// source's path and classifies the result into one of: ok, server_unreachable,
// no_publisher, auth_failed, playback_failed. The SSRF guard runs first.
export type SourceTestStatus = 'ok' | 'server_unreachable' | 'no_publisher' | 'auth_failed' | 'playback_failed';

export async function testSourceConnection(
  source: Record<string, unknown>,
  server: Record<string, unknown> | null
): Promise<{ status: SourceTestStatus; detail?: string }> {
  const apiBase = (server?.private_api_base as string) || process.env.MEDIAMTX_API_URL;
  if (!apiBase) return { status: 'server_unreachable', detail: 'no MediaMTX API base configured' };
  const path = source.mediamtx_path as string;
  let url: URL;
  try {
    url = new URL(`/v3/paths/get/${encodeURIComponent(path)}`, apiBase);
  } catch {
    return { status: 'server_unreachable' };
  }
  try {
    await assertSafeUrl(url.toString());
  } catch (e) {
    return { status: 'server_unreachable', detail: e instanceof Error ? e.message : 'blocked' };
  }
  try {
    const resp = await fetch(url, { headers: { accept: 'application/json' } });
    if (resp.status === 401 || resp.status === 403) return { status: 'auth_failed' };
    if (resp.status === 404) return { status: 'no_publisher' };
    if (!resp.ok) return { status: 'playback_failed', detail: `HTTP ${resp.status}` };
    const body = (await resp.json()) as { ready?: boolean };
    return { status: body?.ready ? 'ok' : 'no_publisher' };
  } catch {
    return { status: 'server_unreachable' };
  }
}

sourcesRouter.post(
  '/:id/test',
  requireAuth,
  requireRole('admin', 'operator'),
  asyncHandler(async (req, res) => {
    const ar = req as AuthedRequest;
    const { rows } = await query('select * from sources where id = $1', [req.params.id], { tag: 'sources.get' });
    const source = rows[0];
    if (!source) throw notFound('source');
    if (ar.role !== 'admin' && !ar.teamIds.includes(source.team_id)) {
      throw forbidden('not a member of this team');
    }
    const s = await query('select * from mediamtx_server_settings where team_id is null limit 1', [], { tag: 'settings.get' });
    const result = await testSourceConnection(source, s.rows[0] || null);
    res.json({ data: result });
  })
);
