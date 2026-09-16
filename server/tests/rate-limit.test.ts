// Unit tests for the in-memory rate limiter middleware.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __resetRateLimit, rateLimit } from '../src/middleware/rate-limit.js';
import type { Request, Response, NextFunction } from 'express';

function mockReq(ip = '1.2.3.4', fwd?: string): Request {
  return {
    headers: fwd ? { 'x-forwarded-for': fwd } : {},
    socket: { remoteAddress: ip },
  } as unknown as Request;
}
function mockRes(): Response & { _status: number; body: unknown; headers: Record<string, string> } {
  const r: any = {
    _status: 0, body: null, headers: {},
    set(k: string, v: string) { this.headers[k.toLowerCase()] = v; return this; },
    json(b: unknown) { this.body = b; return this; },
    status(code: number) { this._status = code; return this; },
  };
  return r;
}

test('allows up to max within window', () => {
  __resetRateLimit();
  const lim = rateLimit({ windowMs: 1000, max: 3, scope: 't1' });
  for (let i = 0; i < 3; i++) {
    const res = mockRes(); let called = false;
    lim(mockReq(), res as any, (() => { called = true; }) as NextFunction);
    assert.equal(called, true, `request ${i} should pass`);
    assert.equal(res._status, 0);
  }
});

test('returns 429 and retry-after when over limit', () => {
  __resetRateLimit();
  const lim = rateLimit({ windowMs: 1000, max: 2, scope: 't2' });
  for (let i = 0; i < 2; i++) lim(mockReq(), mockRes() as any, (() => {}) as NextFunction);
  const res = mockRes(); let called = false;
  lim(mockReq(), res as any, (() => { called = true; }) as NextFunction);
  assert.equal(called, false);
  assert.equal(res._status, 429);
  assert.ok(res.headers['retry-after']);
  assert.equal(res.headers['x-ratelimit-remaining'], '0');
});

test('keys independently per IP', () => {
  __resetRateLimit();
  const lim = rateLimit({ windowMs: 1000, max: 1, scope: 't3' });
  let called1 = false, called2 = false;
  lim(mockReq('1.1.1.1'), mockRes() as any, (() => { called1 = true; }) as NextFunction);
  lim(mockReq('2.2.2.2'), mockRes() as any, (() => { called2 = true; }) as NextFunction);
  assert.equal(called1, true);
  assert.equal(called2, true);
});

test('x-forwarded-for is used when present', () => {
  __resetRateLimit();
  const lim = rateLimit({ windowMs: 1000, max: 1, scope: 't4' });
  let a = false, b = false;
  lim(mockReq('ignored', '9.9.9.9, 8.8.8.8'), mockRes() as any, (() => { a = true; }) as NextFunction);
  lim(mockReq('ignored', '9.9.9.9, 8.8.8.8'), mockRes() as any, (() => { b = true; }) as NextFunction);
  assert.equal(a, true);
  assert.equal(b, false, 'second from same forwarded IP should be limited');
});
