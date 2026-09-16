// Test harness for API integration tests. Creates an isolated schema by
// truncating all tables (the test DB is throwaway), runs migrations if
// needed, seeds an admin + operator + a team + memberships, and returns a
// started app instance plus helpers for authenticated requests (cookie +
// CSRF token). Uses Node's built-in test runner.
import pg from 'pg';
import { createApp } from '../src/app.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://mitchelldawkins@localhost:5432/filmroom_test';

export interface TestContext {
  app: ReturnType<typeof createApp>;
  baseUrl: string;
  close: () => Promise<void>;
  admin: { email: string; password: string; id: string; cookie: string; csrf: string };
  operator: { email: string; password: string; id: string; cookie: string; csrf: string };
  otherTeamOperator: { email: string; password: string; id: string; cookie: string; csrf: string };
  teamId: string;
  otherTeamId: string;
  /** Authenticated fetch helper bound to a user's cookie + CSRF. */
  authed: (user: 'admin' | 'operator' | 'other') => typeof fetch;
}

const TABLES = [
  'audit_events', 'telestrations', 'media_jobs', 'play_angles', 'plays',
  'game_sources', 'source_status_snapshots', 'sources', 'mediamtx_server_settings', 'games',
  'team_members', 'teams', 'users',
];

export async function setupTest(): Promise<TestContext> {
  // Ensure env is set before createApp() reads it.
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-32chars-minimum-ok!!';
  process.env.NODE_ENV = 'test';
  process.env.LIVE_FILMROOM_ENABLED = 'false';
  process.env.API_BASE_PATH = '/api/v1';
  process.env.SSRF_ALLOW_HOSTS = 'mediamtx.test';

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  // Clean slate.
  for (const t of TABLES) await pool.query(`truncate table ${t} cascade`);
  await pool.end();

  // Seed users + teams + memberships directly.
  const seedPool = new pg.Pool({ connectionString: DATABASE_URL });
  const argon2 = (await import('@node-rs/argon2')).default;
  const adminHash = await argon2.hash('admin-pass-1');
  const opHash = await argon2.hash('op-pass-1');
  const otherHash = await argon2.hash('other-pass-1');

  const adminRes = await seedPool.query(
    `insert into users (email, display_name, password_hash, role) values ($1,$2,$3,'admin') returning id`,
    ['admin@test.test', 'Admin', adminHash]
  );
  const opRes = await seedPool.query(
    `insert into users (email, display_name, password_hash, role) values ($1,$2,$3,'operator') returning id`,
    ['op@test.test', 'Operator', opHash]
  );
  const otherRes = await seedPool.query(
    `insert into users (email, display_name, password_hash, role) values ($1,$2,$3,'operator') returning id`,
    ['other@test.test', 'OtherOp', otherHash]
  );
  const teamRes = await seedPool.query(
    `insert into teams (name, slug) values ('Home Team','home') returning id`
  );
  const otherTeamRes = await seedPool.query(
    `insert into teams (name, slug) values ('Other Team','other') returning id`
  );
  await seedPool.query('insert into team_members (user_id, team_id) values ($1,$2), ($3,$4)', [
    opRes.rows[0].id, teamRes.rows[0].id,
    otherRes.rows[0].id, otherTeamRes.rows[0].id,
  ]);
  await seedPool.end();

  const app = createApp();
  const server = app.listen(0); // random port
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;

  // Parse all set-cookie pairs from a Response into a flat map of name->value.
  function parseCookies(res: Response): Record<string, string> {
    const out: Record<string, string> = {};
    // Headers can have multiple set-cookie values; getSetCookie returns them
    // as an array (Node 20+).
    const list = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : []);
    for (const sc of list) {
      const pair = sc.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    return out;
  }

  async function login(email: string, password: string) {
    // First GET to obtain a CSRF token cookie.
    const r0 = await fetch(`${baseUrl}/api/v1/health/live`);
    let cookies = parseCookies(r0);
    let csrf = cookies.csrf || '';
    const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        cookie: cookieHeader(),
      },
      body: JSON.stringify({ email, password }),
    });
    // Merge cookies from the login response.
    cookies = { ...cookies, ...parseCookies(r) };
    csrf = cookies.csrf || csrf;
    return { cookie: cookieHeader(), csrf };
  }

  const adminCreds = await login('admin@test.test', 'admin-pass-1');
  const opCreds = await login('op@test.test', 'op-pass-1');
  const otherCreds = await login('other@test.test', 'other-pass-1');

  const users = {
    admin: { email: 'admin@test.test', password: 'admin-pass-1', id: adminRes.rows[0].id, ...adminCreds },
    operator: { email: 'op@test.test', password: 'op-pass-1', id: opRes.rows[0].id, ...opCreds },
    other: { email: 'other@test.test', password: 'other-pass-1', id: otherRes.rows[0].id, ...otherCreds },
  };

  function authed(user: 'admin' | 'operator' | 'other') {
    const u = users[user];
    return (url: string | URL, init: RequestInit = {}) =>
      fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> || {}), cookie: u.cookie, 'x-csrf-token': u.csrf },
      });
  }

  return {
    app,
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const { closePool } = await import('../src/db/client.js');
      await closePool();
    },
    admin: users.admin,
    operator: users.operator,
    otherTeamOperator: users.other,
    teamId: teamRes.rows[0].id,
    otherTeamId: otherTeamRes.rows[0].id,
    authed,
  };
}
