// Express app assembly. Wires middleware (request id, logging, session, CSRF,
// auth), mounts routers under /api/v1, installs the error handler last. Kept
// separate from index.ts so tests can import the app without listening.
import express from 'express';
import cookieParser from 'cookie-parser';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { requestId } from './middleware/request-id.js';
import { installSession } from './middleware/session.js';
import { csrfToken, csrfProtect } from './middleware/csrf.js';
import { errorHandler } from './middleware/error.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { settingsRouter } from './routes/settings.js';
import { sourcesRouter } from './routes/sources.js';
import { gamesRouter } from './routes/games.js';
import { playsRouter } from './routes/plays.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestId);
  installSession(app);
  // CSRF: issue token on safe methods, verify on state-changing ones.
  app.use(csrfToken);
  app.use(csrfProtect);

  const base = env.API_BASE_PATH; // /api/v1
  app.use(`${base}/health`, healthRouter);
  app.use(`${base}/auth`, authRouter);
  app.use(`${base}/settings`, settingsRouter);
  app.use(`${base}/sources`, sourcesRouter);   // /sources, /sources/:id/...
  app.use(`${base}/games`, gamesRouter);        // /games, /games/:id/...
  app.use(`${base}`, playsRouter);             // /games/:id/plays, /plays/:id, /play-angles/:id/sync

  // Dev/test convenience: serve the repo root statically so the admin UI and
  // the API share an origin (avoids cross-origin cookie/CORS for local E2E).
  // Set SERVE_STATIC_DIR to an absolute or repo-relative path; off by default.
  if (env.SERVE_STATIC_DIR) {
    const dir = resolvePath(__dirname, '..', '..', env.SERVE_STATIC_DIR);
    app.use(express.static(dir, { extensions: ['html'], redirect: false }));
  }

  app.use(errorHandler);
  return app;
}
