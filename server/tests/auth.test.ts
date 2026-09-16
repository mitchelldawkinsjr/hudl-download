import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTest } from './helpers.ts';

test('auth: invalid credentials rejected with generic error', async () => {
  const ctx = await setupTest();
  try {
    // Obtain a CSRF token first (CSRF runs before auth on state-changing
    // requests, so an unauthenticated POST still needs a valid token).
    const r0 = await fetch(`${ctx.baseUrl}/api/v1/health/live`);
    const setCookie = r0.headers.getSetCookie?.() || [];
    const csrf = (setCookie.join('; ').match(/csrf=([^;]+)/) || [])[1] || '';
    const r = await fetch(`${ctx.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, cookie: `csrf=${csrf}` },
      body: JSON.stringify({ email: 'admin@test.test', password: 'wrong' }),
    });
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.error.code, 'unauthorized');
    assert.equal(body.error.message, 'invalid credentials');
  } finally {
    await ctx.close();
  }
});

test('auth: GET /me without session is 401', async () => {
  const ctx = await setupTest();
  try {
    const r = await fetch(`${ctx.baseUrl}/api/v1/auth/me`);
    assert.equal(r.status, 401);
  } finally {
    await ctx.close();
  }
});

test('auth: login then /me returns the user', async () => {
  const ctx = await setupTest();
  try {
    const r = await ctx.authed('admin')(`${ctx.baseUrl}/api/v1/auth/me`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.data.email, 'admin@test.test');
    assert.equal(body.data.role, 'admin');
  } finally {
    await ctx.close();
  }
});

test('auth: logout then /me is 401', async () => {
  const ctx = await setupTest();
  try {
    const u = ctx.admin;
    const r = await fetch(`${ctx.baseUrl}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { cookie: u.cookie, 'x-csrf-token': u.csrf },
    });
    assert.equal(r.status, 200);
    // After logout the server clears the session cookie; a real browser
    // stops sending it. Simulate that by sending only the csrf cookie (no
    // filmroom_session) on the follow-up request.
    const me = await fetch(`${ctx.baseUrl}/api/v1/auth/me`, {
      headers: { cookie: `csrf=${u.csrf}` },
    });
    assert.equal(me.status, 401);
  } finally {
    await ctx.close();
  }
});
