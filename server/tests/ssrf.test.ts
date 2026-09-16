import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeUrl, validateServerUrl, SsrfError } from '../src/security/ssrf.ts';

// SSRF_ALLOW_HOSTS is read live from process.env by ssrf.ts, so set it here.
process.env.SSRF_ALLOW_HOSTS = '127.0.0.1';

test('ssrf: rejects non-http schemes', async () => {
  await assert.rejects(() => assertSafeUrl('file:///etc/passwd'), SsrfError);
  await assert.rejects(() => assertSafeUrl('javascript:alert(1)'), SsrfError);
});

test('ssrf: rejects loopback/private addresses not on allowlist', async () => {
  // 10.0.0.1 is private and NOT on the allowlist (only 127.0.0.1 is).
  await assert.rejects(() => assertSafeUrl('http://10.0.0.1/'), SsrfError);
  await assert.rejects(() => assertSafeUrl('http://192.168.1.1/'), SsrfError);
  await assert.rejects(() => assertSafeUrl('http://[::1]/'), SsrfError);
});

test('ssrf: allows allowlisted private host (IP literal, no DNS)', async () => {
  const c = await assertSafeUrl('http://127.0.0.1:9997/v3/paths/get/drone');
  assert.equal(c.host, '127.0.0.1');
});

test('ssrf: allows public hosts', async () => {
  const c = await assertSafeUrl('https://example.com/path');
  assert.equal(c.host, 'example.com');
});

test('validateServerUrl: rejects credentials in URL', () => {
  assert.throws(() => validateServerUrl('http://user:pass@host/'), SsrfError);
  assert.throws(() => validateServerUrl('ftp://host/'), SsrfError);
  // Private hosts are allowed for STORAGE (enforced at fetch time).
  assert.doesNotThrow(() => validateServerUrl('http://127.0.0.1:9997'));
});
