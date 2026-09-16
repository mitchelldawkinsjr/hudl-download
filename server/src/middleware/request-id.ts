// Request id middleware: reuses an inbound x-request-id if present (and
// shaped like a uuid/cuid), otherwise mints a uuid. Attaches to res.locals
// and the x-request-id response header so every response is traceable.
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

export function requestId(req: Request, res: Response, next: NextFunction) {
  const inbound = req.headers['x-request-id'];
  const id =
    typeof inbound === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(inbound)
      ? inbound
      : randomUUID();
  res.locals.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}
