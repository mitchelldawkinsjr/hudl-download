// Recordings adapter — the boundary between the worker and the external
// MediaMTX recording store. Film Room does NOT mount the MediaMTX disk; it
// fetches recorded segments over HTTP (ADR 0005).
//
// Contract the external MediaMTX (or a small sidecar) must implement:
//   GET {base}/recordings/list?path={path}&from={iso8601}&to={iso8601}
//     -> { segments: [{ url, startIso, endIso, bytes? }] }
//   GET {url}  -> raw segment bytes (fmp4 by default)
// Segments are returned in ascending start order. The adapter only reads;
// it never writes to MediaMTX. A shared-volume mode can be added later by
// swapping this module (the pipeline calls only these functions).
import { assertSafeUrl } from './ssrf.js';

export interface Segment {
  url: string;
  startIso: string;
  endIso: string;
  bytes?: number;
}

export interface RecordingWindow {
  path: string;          // e.g. "games/<gameUuid>/drone"
  fromIso: string;       // inclusive
  toIso: string;          // inclusive
}

export interface RecordingsAdapter {
  listSegments(w: RecordingWindow): Promise<Segment[]>;
  fetchSegment(url: string): Promise<Buffer>;
}

export class HttpRecordingsAdapter implements RecordingsAdapter {
  constructor(private base: string, private maxBytes: number) {
    this.base = base.replace(/\/$/, '');
  }

  async listSegments(w: RecordingWindow): Promise<Segment[]> {
    const u = new URL(`${this.base}/recordings/list`);
    u.searchParams.set('path', w.path);
    u.searchParams.set('from', w.fromIso);
    u.searchParams.set('to', w.toIso);
    await assertSafeUrl(u.toString());
    const r = await fetch(u.toString(), { headers: { accept: 'application/json' } });
    if (r.status >= 500) throw new TransientError(`recordings list ${r.status}`);
    if (r.status === 404) return [];          // no recordings yet
    if (!r.ok) throw new Error(`recordings list failed: ${r.status} ${await r.text()}`);
    const json = (await r.json()) as { segments?: Segment[] };
    const segs = Array.isArray(json.segments) ? json.segments : [];
    return segs.sort((a, b) => a.startIso.localeCompare(b.startIso));
  }

  async fetchSegment(url: string): Promise<Buffer> {
    await assertSafeUrl(url);
    const r = await fetch(url);
    if (r.status >= 500) throw new TransientError(`segment fetch ${r.status}`);
    if (!r.ok) throw new Error(`segment fetch failed: ${r.status} for ${url}`);
    const len = Number(r.headers.get('content-length') || 0);
    if (len && len > this.maxBytes) throw new Error(`segment too large: ${len} bytes`);
    const ab = await r.arrayBuffer();
    if (ab.byteLength > this.maxBytes) throw new Error(`segment too large: ${ab.byteLength} bytes`);
    return Buffer.from(ab);
  }
}

// Error classification: transient errors are retried with backoff; others
// fail the job immediately.
export class TransientError extends Error {
  constructor(msg: string) { super(msg); this.name = 'TransientError'; }
}

export function isTransient(err: unknown): boolean {
  if (err instanceof TransientError) return true;
  const e = err as Error & { code?: string };
  if (!e) return false;
  // Network/timeout/dns codes from undici/node fetch.
  return ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(e.code || '');
}
