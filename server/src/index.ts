// API entry point. Creates the app and listens on PORT. The DB pool is closed
// on shutdown for clean exits.
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool } from './db/client.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`[film-room-api] listening on :${env.PORT} (base ${env.API_BASE_PATH})`);
});

async function shutdown(signal: string) {
  console.log(`[film-room-api] ${signal} received, shutting down`);
  server.close(() => {
    closePool().finally(() => process.exit(0));
  });
  // Force exit after a short grace period if something hangs.
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
