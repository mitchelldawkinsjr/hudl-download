// Auth middleware: requireAuth (any authenticated user), requireRole (one of
// a set of roles), and requireTeam (membership of the team owning the
// resource, resolved by a caller-provided async function returning the
// team_id for the request).
import type { Request, Response, NextFunction } from 'express';
import { unauthorized, forbidden } from './error.js';
import { getSessionData } from './session.js';

export interface AuthedRequest extends Request {
  userId: string;
  role: string;
  teamIds: string[];
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const s = getSessionData(req);
  if (!s || !s.userId || !s.role) {
    next(unauthorized());
    return;
  }
  (req as AuthedRequest).userId = s.userId;
  (req as AuthedRequest).role = s.role;
  (req as AuthedRequest).teamIds = s.teamIds || [];
  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const r = (req as AuthedRequest).role;
    if (!r || !roles.includes(r)) {
      next(forbidden('insufficient role'));
      return;
    }
    next();
  };
}

/** Require membership of a specific team. */
export function requireTeam(getTeamId: (req: Request) => Promise<string | null>) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const ar = req as AuthedRequest;
      if (ar.role === 'admin') {
        next();
        return;
      }
      const teamId = await getTeamId(req);
      if (!teamId || !ar.teamIds.includes(teamId)) {
        next(forbidden('not a member of this team'));
        return;
      }
      next();
    } catch (err) {
      // Express 4 does not auto-catch rejected middleware promises, so
      // forward explicitly (e.g. requireUuid throwing notFound).
      next(err);
    }
  };
}
