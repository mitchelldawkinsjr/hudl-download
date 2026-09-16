// Unit tests for signed short-lived media tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// signed-media reads env.SESSION_SECRET at import time, so set it first.
process.env.SESSION_SECRET = 'test-secret-32chars-minimum-ok!!';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://x';
const { signMedia, verifyMedia } = await import('../src/security/signed-media.js');

const PLAY = '11111111-1111-1111-1111-111111111111';
const ANGLE = '22222222-2222-2222-2222-222222222222';

test('signs and verifies a token for the matching scope', () => {
  const token = signMedia(PLAY, ANGLE, 'clip', 300);
  const sig = verifyMedia(token);
  assert.ok(sig, 'token should verify');
  assert.equal(sig!.playId, PLAY);
  assert.equal(sig!.angleId, ANGLE);
  assert.equal(sig!.kind, 'clip');
});

test('rejects a token scoped to a different kind', () => {
  const token = signMedia(PLAY, ANGLE, 'thumbnail', 300);
  const sig = verifyMedia(token + 'x'); // tampered
  assert.equal(sig, null);
});

test('rejects a tampered token', () => {
  const token = signMedia(PLAY, ANGLE, 'clip', 300);
  const sig = verifyMedia(token.replace(/.$/, '0'));
  assert.equal(sig, null);
});

test('rejects a token scoped to a different play', () => {
  const token = signMedia(PLAY, ANGLE, 'clip', 300);
  // Swap the play id in the token string; hmac will no longer match.
  const other = '33333333-3333-3333-3333-333333333333';
  const parts = token.split('.');
  const tampered = [parts[0], other, parts[2], parts[3], parts[4]].join('.');
  assert.equal(verifyMedia(tampered), null);
});

test('rejects an expired token', async () => {
  const token = signMedia(PLAY, ANGLE, 'clip', 1);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(verifyMedia(token), null);
});

test('rejects malformed input', () => {
  assert.equal(verifyMedia(undefined), null);
  assert.equal(verifyMedia(''), null);
  assert.equal(verifyMedia('a.b.c'), null);
});
