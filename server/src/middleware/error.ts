// Error envelope + async route wrapper. Every error response uses the
// consistent shape from the spec: { error: { code, message, details?, requestId } }.
import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError('bad_request', message, 400, details);
export const unauthorized = (message = 'unauthorized') =>
  new AppError('unauthorized', message, 401);
export const forbidden = (message = 'forbidden') =>
  new AppError('forbidden', message, 403);
export const notFound = (message = 'not found') =>
  new AppError('not_found', message, 404);
export const conflict = (message: string, details?: unknown) =>
  new AppError('conflict', message, 409, details);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate a path param is a UUID; throw notFound otherwise (so /me etc. don't
 * 500 on a non-uuid :id match). */
export function requireUuid(value: string, name = 'id'): string {
  if (!UUID_RE.test(value)) throw notFound(`${name} not found`);
  return value;
}

/** Wrap an async route handler so rejected promises flow to the error
 * handler instead of hanging the request. */
export function asyncHandler<Req extends Request = Request, Res extends Response = Response>(
  fn: (req: Req, res: Res, next: NextFunction) => Promise<unknown>
) {
  return (req: Req, res: Res, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = (req.headers['x-request-id'] as string) || (res.locals.requestId as string) || '';
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: 'bad_request', message: 'validation failed', details: err.flatten(), requestId },
    });
    return;
  }
  // Unexpected error — never leak internals; log server-side.
  console.error('[unhandled]', err instanceof Error ? err.stack : err);
  res.status(500).json({
    error: { code: 'internal_error', message: 'internal error', requestId },
  });
}
