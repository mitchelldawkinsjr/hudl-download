// Signed, short-lived media URLs (Phase 7 hardening). Mints an HMAC-SHA256
// token binding a play+angle+kind to an expiry, so a clip/thumbnail can be
// served without a live session (e.g. a shared review link) while remaining
// non-enumerable and time-boxed. The session-based auth path stays the
// default; the signed path is an alternative for share-out.
//
// Token format: <expEpochSec>.<playId>.<angleId>.<kind>.<hmacHex>
//   - exp: seconds since epoch; rejected if in the past
//   - hmac: HMAC-SHA256 over "<exp>.<playId>.<angleId>.<kind>" with SESSION_SECRET
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

export interface SignedMedia {
  exp: number;
  playId: string;
  angleId: string;
  kind: 'clip' | 'thumbnail';
}

export function signMedia(playId: string, angleId: string, kind: 'clip' | 'thumbnail', ttlSec = 300): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${exp}.${playId}.${angleId}.${kind}`;
  return `${payload}.${hmac(payload)}`;
}

function hmac(payload: string): string {
  return createHmac('sha256', env.SESSION_SECRET).update(payload).digest('hex');
}

export function verifyMedia(token: string | undefined): SignedMedia | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [expStr, playId, angleId, kind, mac] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  if (kind !== 'clip' && kind !== 'thumbnail') return null;
  // Validate UUID-ish shape for the ids (cheap pre-check).
  if (!/^[0-9a-f-]{30,40}$/i.test(playId) || !/^[0-9a-f-]{30,40}$/i.test(angleId)) return null;
  const expected = hmac(`${expStr}.${playId}.${angleId}.${kind}`);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (exp * 1000 <= Date.now()) return null; // expired
  return { exp, playId, angleId, kind };
}
