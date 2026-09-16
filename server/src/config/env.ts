// Centralized, validated environment configuration. Loads .env in dev (via
// dotenv) and validates against a Zod schema with safe defaults so the
// process fails fast on a missing required value rather than at request time.
// No secret is ever logged.
import { z } from 'zod';
import dotenv from 'dotenv';

// In dev the API runs with tsx and a local .env; in production the platform
// injects real env vars. dotenv only sets vars not already present, so it's
// safe to call unconditionally.
dotenv.config();

const bool = z
  .string()
  .transform((v) => v === 'true' || v === '1')
  .default('false');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  // Base path the reverse proxy exposes the API under. Defaults to /api/v1.
  API_BASE_PATH: z.string().default('/api/v1'),

  // Session cookie signing. Required in production.
  SESSION_SECRET: z.string().min(16),
  // Canonical public HTTPS origin (used for cookie same-site reasoning and
  // signed-URL audiences). Not used to make outbound calls.
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),

  // External MediaMTX connection (ADR 0005). These are private, server-side
  // only — never sent to the browser. The Sources & Settings screen stores
  // per-tenant overrides in the DB; these are the bootstrap defaults.
  MEDIAMTX_API_URL: z.string().url().optional(),
  MEDIAMTX_PLAYBACK_URL: z.string().url().optional(),
  MEDIAMTX_RECORDING_HTTP_BASE: z.string().url().optional(),
  MEDIAMTX_HLS_PUBLIC_BASE: z.string().url().optional(),
  MEDIAMTX_WEBRTC_PUBLIC_BASE: z.string().url().optional(),
  MEDIAMTX_RTMP_HOST: z.string().optional(),
  MEDIAMTX_RTMP_PORT: z.coerce.number().int().positive().default(1935),

  // Derived media + temp roots (worker uses these; API only needs MEDIA_ROOT
  // for signing/redirects).
  MEDIA_ROOT: z.string().default('./data/media'),
  TEMP_ROOT: z.string().default('./data/tmp'),

  // Play capture defaults (ms).
  DEFAULT_PRE_ROLL_MS: z.coerce.number().int().min(0).default(18000),
  DEFAULT_POST_ROLL_MS: z.coerce.number().int().min(0).default(3000),
  RECORDING_SETTLE_MS: z.coerce.number().int().min(0).default(2000),
  MAX_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),

  // SSRF allowlist: the private MediaMTX host is normally loopback/private,
  // which the SSRF guard would block. Operators add it here explicitly.
  SSRF_ALLOW_HOSTS: z.string().default(''),

  // Feature flag for the live system (ADR 0002). Offline local-film viewer
  // works regardless.
  LIVE_FILMROOM_ENABLED: bool,

  // Dev/test convenience: serve a static dir from the API origin so the admin
  // UI and API share an origin for local E2E. Off by default.
  SERVE_STATIC_DIR: z.string().optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Database. Required.
  DATABASE_URL: z.string().min(1),
});

export type Env = z.infer<typeof schema>;

function parse() {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    // Print only the issues, never the (absent) secret values.
    console.error('Invalid environment configuration:', result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
}

export const env: Env = parse();

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
