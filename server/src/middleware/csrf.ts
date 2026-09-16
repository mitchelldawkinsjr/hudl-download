// CSRF protection via the double-submit pattern. On any authenticated GET,
// the API sets a non-HttpOnly `csrf` cookie containing a random token; the
// client must echo it back as the `x-csrf-token` header on every state-changing
// request (POST/PATCH/PUT/DELETE). The middleware compares the header to the
// cookie; a mismatch rejects. SameSite=Lax on the session cookie already
// blocks cross-site POSTs from being credentialed, but the double-submit token
// is the spec's required CSRF defense for the chosen session implementation.
import type { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { forbidden } from './error.js';

const COOKIE = 'csrf';
const HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
  const cookie = req.cookies?.[COOKIE];
  const header = req.headers[HEADER];
  if (
    typeof cookie !== 'string' ||
    typeof header !== 'string' ||
    !timingSafeEqual(cookie, header)
  ) {
    next(forbidden('invalid csrf token'));
    return;
  }
  next();
}
