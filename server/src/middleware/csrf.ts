// CSRF protection via the double-submit pattern. On any authenticated GET,
// the API sets a non-HttpOnly `csrf` cookie containing a random token; the
// client must echo it back as the `x-csrf-token` header on every state-changing
// request (POST/PATCH/PUT/DELETE). The middleware compares the header to the
// cookie; a mismatch rejects. SameSite=Lax on the session cookie already
// blocks cross-site POSTs from being credentialed, but the double-submit token
// is the spec's required CSRF defense for the chosen session implementation.
import type { Request, Response, NextFunction } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { forbidden } from './error.js';

const COOKIE = 'csrf';
const HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function safeEqual(a: string, b: string): boolean {
  // Constant-time compare via the stdlib. Length mismatch still returns
  // early, which is fine here (the token is a random secret, not a secret
  // whose length is sensitive).
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function csrfToken(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) {
    let token = req.cookies?.[COOKIE];
    if (!token || typeof token !== 'string') {
      token = randomBytes(24).toString('base64url');
    }
    res.cookie(COOKIE, token, {
      httpOnly: false,
      sameSite: 'lax',
      secure: req.secure,
      path: '/',
    });
    res.locals.csrfToken = token;
  }
  next();
}

export function csrfProtect(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  // Test-only reset endpoint bypasses CSRF (never mounted in production).
  // req.path is the full path (e.g. /api/v1/_test/reset), so match by suffix.
  if (process.env.NODE_ENV === 'test' && req.path.includes('/_test/')) {
    next();
    return;
  }
  const cookie = req.cookies?.[COOKIE];
  const header = req.headers[HEADER];
  if (
    typeof cookie !== 'string' ||
    typeof header !== 'string' ||
    !safeEqual(cookie, header)
  ) {
    next(forbidden('invalid csrf token'));
    return;
  }
  next();
}
