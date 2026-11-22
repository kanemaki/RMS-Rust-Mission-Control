import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-license-'));
process.env.RMC_DATA_DIR = dataDir;
process.env.RMC_TRIAL_DAYS = '14';

const rustdsDir = path.join(dataDir, 'rustds');
fs.mkdirSync(rustdsDir, { recursive: true });

const { createApi } = await import('../src/api.js');
const {
  EMBEDDED_PUBLIC_KEY,
  canonicalize,
  licenseStatus,
  setLicensePublicKey,
  verifyLicense,
} = await import('../src/license.js');
const { setMeta } = await import('../src/db.js');

const DAY = 24 * 60 * 60 * 1000;
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const testPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
setLicensePublicKey(testPublicKey);

function sign(payload) {
  const signature = crypto.sign(null, Buffer.from(canonicalize(payload), 'utf8'), privateKey).toString('base64url');
  return JSON.stringify({ payload, signature }, null, 2);
}

function payload(overrides = {}) {
  const issued = Date.now();
  return {
    v: 1,
    keyId: 'rms-test',
    licenseId: 'RMS-TEST-0001',
    licensee: 'Cliente de Teste',
    plan: 'pro',
    maxServers: 2,
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + 365 * DAY).toISOString(),
    installId: null,
    ...overrides,
  };
}

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

test('licença: JSON canônico e verificação de assinatura', () => {
  assert.equal(canonicalize({ b: 1, a: { d: 2, c: [3, 4] } }), '{"a":{"c":[3,4],"d":2},"b":1}');

  const text = sign(payload());
  const ok = verifyLicense(text);
  assert.equal(ok.ok, true);
  assert.equal(ok.payload.licenseId, 'RMS-TEST-0001');

  const tampered = JSON.parse(text);
  tampered.payload.maxServers = 999;
  const badPayload = verifyLicense(JSON.stringify(tampered));
  assert.equal(badPayload.ok, false);
  assert.match(badPayload.error, /Assinatura/);

  const badSignature = JSON.parse(text);
  badSignature.signature = Buffer.alloc(64).toString('base64url');
  assert.equal(verifyLicense(JSON.stringify(badSignature)).ok, false);

  assert.equal(verifyLicense('não é json').ok, false);
  assert.equal(verifyLicense(JSON.stringify({ payload: payload() })).ok, false);
  assert.equal(verifyLicense(sign(payload({ v: 2 }))).ok, false);
  assert.equal(verifyLicense(sign(payload({ maxServers: 0 }))).ok, false);

  const other = crypto.generateKeyPairSync('ed25519');
  const otherRaw = other.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  assert.equal(verifyLicense(text, { key: otherRaw }).ok, false);
  assert.equal(verifyLicense(text, { key: testPublicKey }).ok, true);
  assert.match(EMBEDDED_PUBLIC_KEY, /^[A-Za-z0-9_-]{43}$/);
});

test('licença: trial, aplicação, limite de servidores e modo somente leitura', async () => {
  const setup = await call('/setup', { method: 'POST', body: { password: 'senha-de-teste-123' } });
  assert.equal(setup.status, 200);
  const cookie = setup.cookie;

  const trial = await call('/license', { cookie });
  assert.equal(trial.status, 200);
  assert.equal(trial.data.state, 'trial');
  assert.equal(trial.data.readOnly, false);
  assert.equal(trial.data.trial.daysLeft, 14);
  assert.equal(trial.data.maxServers, null);

  const rejected = await call('/license', { method: 'POST', cookie, body: { text: '{"payload":{}}' } });
  assert.equal(rejected.status, 400);

  const applied = await call('/license', { method: 'POST', cookie, body: { text: sign(payload({ maxServers: 1 })) } });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.state, 'valid');
  assert.equal(applied.data.licensee, 'Cliente de Teste');
  assert.equal(applied.data.maxServers, 1);
  assert.equal(applied.data.readOnly, false);

  const first = await call('/servers', {
    method: 'POST',
    cookie,
    body: { identity: 'lic_one', installDir: rustdsDir, port: 28015, rconPort: 28016 },
  });
  assert.equal(first.status, 201);

  const overLimit = await call('/servers', {
    method: 'POST',
    cookie,
    body: { identity: 'lic_two', installDir: rustdsDir, port: 28017, rconPort: 28018 },
  });
  assert.equal(overLimit.status, 400);
  assert.match(overLimit.data.error, /até 1 servidor/);

  const wider = await call('/license', { method: 'POST', cookie, body: { text: sign(payload({ maxServers: 2 })) } });
  assert.equal(wider.status, 200);
  const second = await call('/servers', {
    method: 'POST',
    cookie,
    body: { identity: 'lic_two', installDir: rustdsDir, port: 28017, rconPort: 28018 },
  });
  assert.equal(second.status, 201);

  const expired = await call('/license', {
    method: 'POST',
    cookie,
    body: {
      text: sign(
        payload({
          licenseId: 'RMS-TEST-EXPIRED',
          issuedAt: new Date(Date.now() - 10 * DAY).toISOString(),
          expiresAt: new Date(Date.now() - DAY).toISOString(),
        }),
      ),
    },
  });
  assert.equal(expired.status, 200);
  assert.equal(expired.data.state, 'expired');
  assert.equal(expired.data.readOnly, true);

  const blockedEdit = await call('/servers/lic_one', { method: 'PATCH', cookie, body: { name: 'Novo nome' } });
  assert.equal(blockedEdit.status, 403);
  assert.equal(blockedEdit.data.license.state, 'expired');

  const blockedCreate = await call('/servers', {
    method: 'POST',
    cookie,
    body: { identity: 'lic_three', installDir: rustdsDir, port: 28019, rconPort: 28020 },
  });
  assert.equal(blockedCreate.status, 403);

  // Leitura e operação continuam liberadas no modo somente leitura.
  const list = await call('/servers', { cookie });
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 2);

  const removed = await call('/license', { method: 'DELETE', cookie });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.removed, true);
  assert.equal(removed.data.license.state, 'trial');

  const allowedAgain = await call('/servers/lic_one', { method: 'PATCH', cookie, body: { name: 'Novo nome' } });
  assert.equal(allowedAgain.status, 200);
});

test('licença: trial expira e relógio atrasado não renova', () => {
  const now = Date.now();
  setMeta('trial_started_at', String(now - 15 * DAY));
  const expired = licenseStatus({ now });
  assert.equal(expired.state, 'expired');
  assert.equal(expired.readOnly, true);
  assert.equal(expired.trial.daysLeft, 0);

  setMeta('trial_started_at', String(now));
  const rolledBack = licenseStatus({ now: now - 2 * DAY });
  assert.equal(rolledBack.state, 'trial');
  assert.equal(rolledBack.trial.daysLeft, 14);
});
