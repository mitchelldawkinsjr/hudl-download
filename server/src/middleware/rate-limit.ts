// Simple in-memory rate limiter (sliding-window count per key). Suitable for
// a single API process; for multi-process deployments, back this with Redis.
// Returns 429 with retry-after seconds when the limit is exceeded. Keys are
// composed from a scope + an identifier (IP or userId) so different routes
// get independent buckets.
import type { Request, Response, NextFunction } from 'express';

interface Bucket {
  count: number;
  resetAt: number; // epoch ms
}

const buckets = new Map<string, Bucket>();

// Periodic sweep so idle keys don't leak memory. One sweep per process is
// enough; entries expire on their own after the window.
let lastSweep = 0;
function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  scope: string;
  keyFn?: (req: Request) => string;
}

function defaultKey(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const ip =
    (typeof fwd === 'string' ? fwd.split(',')[0]?.trim() : undefined) ||
    req.socket?.remoteAddress ||
    'unknown';
  return ip;
}

export function rateLimit(opts: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    sweep(now);
    const id = (opts.keyFn ?? defaultKey)(req);
    const key = `${opts.scope}:${id}`;
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    const remaining = Math.max(0, opts.max - b.count);
    const retryAfterSec = Math.ceil((b.resetAt - now) / 1000);
    res.set('x-ratelimit-limit', String(opts.max));
    res.set('x-ratelimit-remaining', String(remaining));
    res.set('x-ratelimit-reset', String(b.resetAt));
    if (b.count > opts.max) {
      res.set('retry-after', String(retryAfterSec));
      res.status(429).json({ error: { code: 'rate_limited', message: 'too many requests, slow down' } });
      return;
    }
    next();
  };
}

// Test-only helper to reset state between suites.
export function __resetRateLimit() {
  buckets.clear();
  lastSweep = 0;
}
