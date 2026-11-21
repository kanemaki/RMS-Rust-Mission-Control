import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-totp-'));
process.env.RMC_DATA_DIR = dataDir;

const { createApi } = await import('../src/api.js');
const { base32Decode, base32Encode, hotp, totp, verifyTotp } = await import('../src/totp.js');

const app = express();
app.use(express.json());
app.use('/api', createApi({ version: 'test' }));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => server.close());

async function call(pathname, { method = 'GET', cookie, body } = {}) {
  const headers = { 'x-rmc-request': '1' };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/api${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data, cookie: res.headers.getSetCookie()[0]?.split(';')[0] };
}

test('totp: vetores RFC 6238 e janela de tolerância', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(hotp(secret, 1), '287082');
  assert.equal(totp(secret, { now: 59_000 }), '287082');
  assert.equal(totp(secret, { now: 1_111_111_109_000 }), '081804');

  const now = 1_700_000_000_000;
  const code = totp(secret, { now });
  assert.equal(verifyTotp(secret, code, { now }), true);
  assert.equal(verifyTotp(secret, code, { now: now + 30_000 }), true);
  assert.equal(verifyTotp(secret, code, { now: now + 120_000 }), false);
  assert.equal(verifyTotp(secret, '000000', { now }), false);
  assert.equal(verifyTotp(secret, 'abc', { now }), false);
});

test('2fa: ativar, exigir código no login, usar recuperação e desativar', async () => {
  const setup = await call('/setup', { method: 'POST', body: { password: 'senha-de-teste-123' } });
  assert.equal(setup.status, 200);
  let cookie = setup.cookie;

  const me = await call('/auth/me', { cookie });
  assert.equal(me.data.totpEnabled, false);

  const started = await call('/auth/totp/setup', { method: 'POST', cookie, body: {} });
  assert.equal(started.status, 200);
  assert.match(started.data.secret, /^[A-Z2-7]{32}$/);
  assert.match(started.data.otpauth, /^otpauth:\/\/totp\//);
  assert.match(started.data.qr, /^data:image\/png;base64,/);

  const wrongEnable = await call('/auth/totp/enable', { method: 'POST', cookie, body: { code: '000000' } });
  assert.equal(wrongEnable.status, 400);

  const enabled = await call('/auth/totp/enable', {
    method: 'POST',
    cookie,
    body: { code: totp(started.data.secret) },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.recoveryCodes.length, 10);
  const recoveryCode = enabled.data.recoveryCodes[0];

  const status = await call('/auth/totp', { cookie });
  assert.equal(status.data.enabled, true);
  assert.equal(status.data.recoveryCodesLeft, 10);

  await call('/auth/logout', { method: 'POST', cookie, body: {} });

  const login = await call('/auth/login', { method: 'POST', body: { password: 'senha-de-teste-123' } });
  assert.equal(login.status, 200);
  assert.equal(login.data.totpRequired, true);
  assert.ok(login.data.challenge);
  assert.equal(login.cookie, undefined);

  const badCode = await call('/auth/login/totp', {
    method: 'POST',
    body: { challenge: login.data.challenge, code: '000000' },
  });
  assert.equal(badCode.status, 401);

  const goodCode = await call('/auth/login/totp', {
    method: 'POST',
    body: { challenge: login.data.challenge, code: totp(started.data.secret) },
  });
  assert.equal(goodCode.status, 200);
  assert.ok(goodCode.cookie);
  cookie = goodCode.cookie;

  const reused = await call('/auth/login/totp', {
    method: 'POST',
    body: { challenge: login.data.challenge, code: totp(started.data.secret) },
  });
  assert.equal(reused.status, 401);

  await call('/auth/logout', { method: 'POST', cookie, body: {} });

  const login2 = await call('/auth/login', { method: 'POST', body: { password: 'senha-de-teste-123' } });
  const recovery = await call('/auth/login/totp', {
    method: 'POST',
    body: { challenge: login2.data.challenge, code: recoveryCode },
  });
  assert.equal(recovery.status, 200);
  assert.equal(recovery.data.recovery, true);
  cookie = recovery.cookie;

  const afterUse = await call('/auth/totp', { cookie });
  assert.equal(afterUse.data.recoveryCodesLeft, 9);

  const login3 = await call('/auth/login', { method: 'POST', body: { password: 'senha-de-teste-123' } });
  const reusedRecovery = await call('/auth/login/totp', {
    method: 'POST',
    body: { challenge: login3.data.challenge, code: recoveryCode },
  });
  assert.equal(reusedRecovery.status, 401);

  const wrongPassword = await call('/auth/totp/disable', {
    method: 'POST',
    cookie,
    body: { password: 'senha-errada-123', code: totp(started.data.secret) },
  });
  assert.equal(wrongPassword.status, 400);

  const disabled = await call('/auth/totp/disable', {
    method: 'POST',
    cookie,
    body: { password: 'senha-de-teste-123', code: totp(started.data.secret) },
  });
  assert.equal(disabled.status, 200);

  await call('/auth/logout', { method: 'POST', cookie, body: {} });
  const plainLogin = await call('/auth/login', { method: 'POST', body: { password: 'senha-de-teste-123' } });
  assert.equal(plainLogin.status, 200);
  assert.equal(plainLogin.data.totpRequired, undefined);
  assert.ok(plainLogin.cookie);
});
