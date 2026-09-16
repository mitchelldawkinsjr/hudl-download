// SSRF guard for outbound server-side URL fetching (MediaMTX Control API,
// recording HTTP, source tests). Validates the URL scheme + host and denies
// private/loopback/link-local targets unless the host is on an explicit
// allowlist (SSRF_ALLOW_HOSTS), since the private MediaMTX host is normally
// on a private network (ADR 0005).
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Read the SSRF allowlist live from the environment so tests (and runtime
// config reloads) can change it without re-importing. Hosts on this list bypass
// the private-address rejection (the private MediaMTX host is normally on a
// private network — ADR 0005). Lowercased, trimmed, comma-separated.
function allowHosts(): Set<string> {
  return new Set(
    (process.env.SSRF_ALLOW_HOSTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

function isPrivateIp(ip: string): boolean {
  // v4
  if (isIP(ip) === 4) {
    if (ip === '0.0.0.0' || ip.startsWith('10.') || ip.startsWith('127.')) return true;
    if (ip.startsWith('169.254.')) return true; // link-local
    if (ip.startsWith('192.168.')) return true;
    if (ip.startsWith('172.')) {
      const o = parseInt(ip.split('.')[1], 10);
      if (o >= 16 && o <= 31) return true;
    }
    if (ip.startsWith('100.')) {
      const o = parseInt(ip.split('.')[1], 10);
      if (o >= 64 && o <= 127) return true; // CGNAT
    }
    return false;
  }
  // v6
  if (isIP(ip) === 6) {
    const lo = ip.toLowerCase();
    return lo === '::1' || lo.startsWith('fc') || lo.startsWith('fd') || lo === '::' ||
      lo.startsWith('fe80:'); // link-local
  }
  return false;
}

export interface CheckedUrl {
  url: URL;
  host: string;
}

/**
 * Validate a URL for server-side fetching. Throws SsrfError on rejection.
 * Resolves DNS and checks each resolved address. Hosts in SSRF_ALLOW_HOSTS
 * bypass the private-address check (still must be http(s)).
 */
export async function assertSafeUrl(raw: string): Promise<CheckedUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('only http/https schemes are permitted');
  }
  const host = url.hostname.toLowerCase();
  const allowed = allowHosts().has(host);

  // If it's an IP literal, check directly.
  if (isIP(host)) {
    if (!allowed && isPrivateIp(host)) {
      throw new SsrfError(`private/loopback host not allowed: ${host}`);
    }
    return { url, host };
  }

  // Resolve and check each address. If any address is private and the host
  // isn't explicitly allowed, reject.
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new SsrfError(`could not resolve host: ${host}`);
  }
  if (!addrs.length) throw new SsrfError(`no addresses for host: ${host}`);
  if (!allowed) {
    for (const a of addrs) {
      if (isPrivateIp(a.address)) {
        throw new SsrfError(`host ${host} resolves to private address ${a.address}`);
      }
    }
  }
  return { url, host };
}

/** Validate a URL string without resolving DNS — for storing user-entered
 * server addresses in the DB. Rejects bad schemes; does NOT reject private
 * hosts (the MediaMTX private base is legitimately private). DNS/private
 * enforcement happens at fetch time via assertSafeUrl + the allowlist. */
export function validateServerUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('only http/https schemes are permitted');
  }
  if (url.username || url.password) {
    throw new SsrfError('credentials in URL are not permitted');
  }
  return url;
}
