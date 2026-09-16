// SSRF guard for the worker's outbound HTTP fetches to the external MediaMTX
// recording store. Same semantics as the API's guard (server/src/security/
// ssrf.ts); duplicated here so the worker is a standalone package. Denies
// private/loopback/link-local targets unless the host is on SSRF_ALLOW_HOSTS.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function allowHosts(): Set<string> {
  return new Set(
    (process.env.SSRF_ALLOW_HOSTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export class SsrfError extends Error {
  constructor(message: string) { super(message); this.name = 'SsrfError'; }
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    if (ip === '0.0.0.0' || ip.startsWith('10.') || ip.startsWith('127.')) return true;
    if (ip.startsWith('169.254.')) return true;
    if (ip.startsWith('192.168.')) return true;
    if (ip.startsWith('172.')) {
      const o = parseInt(ip.split('.')[1], 10);
      if (o >= 16 && o <= 31) return true;
    }
    if (ip.startsWith('100.')) {
      const o = parseInt(ip.split('.')[1], 10);
      if (o >= 64 && o <= 127) return true;
    }
    return false;
  }
  if (isIP(ip) === 6) {
    const lo = ip.toLowerCase();
    return lo === '::1' || lo.startsWith('fc') || lo.startsWith('fd') || lo === '::' || lo.startsWith('fe80:');
  }
  return false;
}

export async function assertSafeUrl(raw: string): Promise<{ url: URL; host: string }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new SsrfError('invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('only http/https schemes are permitted');
  }
  const host = url.hostname.toLowerCase();
  const allowed = allowHosts().has(host);
  if (isIP(host)) {
    if (!allowed && isPrivateIp(host)) throw new SsrfError(`private/loopback host not allowed: ${host}`);
    return { url, host };
  }
  let addrs: { address: string }[];
  try { addrs = await lookup(host, { all: true }); } catch { throw new SsrfError(`could not resolve host: ${host}`); }
  if (!addrs.length) throw new SsrfError(`no addresses for host: ${host}`);
  if (!allowed) {
    for (const a of addrs) {
      if (isPrivateIp(a.address)) throw new SsrfError(`host ${host} resolves to private address ${a.address}`);
    }
  }
  return { url, host };
}
