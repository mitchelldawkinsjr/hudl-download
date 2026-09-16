// Settings routes — MediaMTX server connection config. Admin/operator only.
// Stores public_playback_base, private_api_base, private_playback_base,
// webrtc/hls public bases, rtmp host/port. Private values stay server-side;
// GET returns them only to authorized users (the screen is admin-gated).
import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/client.js';
import { audit } from '../services/audit.js';
import { asyncHandler, badRequest } from '../middleware/error.js';
import { requireAuth, requireRole, type AuthedRequest } from '../middleware/auth.js';
import { validateServerUrl, SsrfError } from '../security/ssrf.js';

export const settingsRouter = Router();

const settingsSchema = z.object({
  publicPlaybackBase: z.string().url().nullable(),
  privateApiBase: z.string().url().nullable(),
  privatePlaybackBase: z.string().url().nullable(),
  webrtcPublicBase: z.string().url().nullable(),
  hlsPublicBase: z.string().url().nullable(),
  rtmpHost: z.string().max(255).nullable(),
  rtmpPort: z.number().int().min(1).max(65535),
});

function validateSettings(input: z.infer<typeof settingsSchema>) {
  const parsed = settingsSchema.parse(input);
  // Validate URL fields with the SSRF URL validator (scheme + no creds;
  // private hosts are allowed for storage, enforced at fetch time).
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string' && (k.endsWith('Base') || k.endsWith('Url'))) {
      try {
        validateServerUrl(v);
      } catch (e) {
        if (e instanceof SsrfError) throw badRequest(`invalid ${k}: ${e.message}`);
        throw badRequest(`invalid ${k}`);
      }
    }
  }
  return parsed;
}

settingsRouter.get(
  '/',
  requireAuth,
  requireRole('admin', 'operator'),
  asyncHandler(async (_req, res) => {
    const { rows } = await query(
      `select id, team_id, public_playback_base, private_api_base, private_playback_base,
              webrtc_public_base, hls_public_base, rtmp_host, rtmp_port
       from mediamtx_server_settings where team_id is null limit 1`,
      [],
      { tag: 'settings.get' }
    );
    if (!rows[0]) {
      res.json({ data: null });
      return;
    }
    const r = rows[0];
    res.json({
      data: {
        id: r.id,
        publicPlaybackBase: r.public_playback_base,
        privateApiBase: r.private_api_base,
        privatePlaybackBase: r.private_playback_base,
        webrtcPublicBase: r.webrtc_public_base,
        hlsPublicBase: r.hls_public_base,
        rtmpHost: r.rtmp_host,
        rtmpPort: r.rtmp_port,
      },
    });
  })
);

settingsRouter.put(
  '/',
  requireAuth,
  requireRole('admin', 'operator'),
  asyncHandler(async (req, res) => {
    const parsed = validateSettings(req.body ?? {});
    const ar = req as AuthedRequest;
    const before = await query(
      `select id from mediamtx_server_settings where team_id is null`,
      [],
      { tag: 'settings.getBefore' }
    );
    const row = await withTransaction(async (c) => {
      if (before.rows[0]) {
        const r = await c.query(
          `update mediamtx_server_settings set
             public_playback_base=$1, private_api_base=$2, private_playback_base=$3,
             webrtc_public_base=$4, hls_public_base=$5, rtmp_host=$6, rtmp_port=$7,
             updated_by=$8
           where team_id is null returning id`,
          [
            parsed.publicPlaybackBase, parsed.privateApiBase, parsed.privatePlaybackBase,
            parsed.webrtcPublicBase, parsed.hlsPublicBase, parsed.rtmpHost, parsed.rtmpPort,
            ar.userId,
          ]
        );
        return r.rows[0];
      }
      const r = await c.query(
        `insert into mediamtx_server_settings
           (team_id, public_playback_base, private_api_base, private_playback_base,
            webrtc_public_base, hls_public_base, rtmp_host, rtmp_port, updated_by)
         values (null, $1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [
          parsed.publicPlaybackBase, parsed.privateApiBase, parsed.privatePlaybackBase,
          parsed.webrtcPublicBase, parsed.hlsPublicBase, parsed.rtmpHost, parsed.rtmpPort,
          ar.userId,
        ]
      );
      return r.rows[0];
    });
    await audit({
      actorId: ar.userId,
      action: 'settings.mediamtx_server.update',
      entityType: 'mediamtx_server_settings',
      entityId: row.id,
      before: before.rows[0] ? { existed: true } : null,
      after: parsed,
      requestId: res.locals.requestId,
    });
    res.json({ data: { id: row.id, ...parsed } });
  })
);
