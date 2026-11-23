import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-users-'));
process.env.RMC_DATA_DIR = dataDir;

// Credencial legada no config.json: deve virar o usuário owner na migração.
const legacySalt = crypto.randomBytes(16).toString('hex');
const legacyHash = crypto.scryptSync('senha-legada-123', legacySalt, 64).toString('hex');
fs.writeFileSync(
  path.join(dataDir, 'config.json'),
  JSON.stringify({
    version: 1,
    auth: {
      passwordHash: legacyHash,
      salt: legacySalt,
      createdAt: new Date().toISOString(),
      totp: { enabled: false, secret: null, pendingSecret: null, recoveryCodes: [], enabledAt: null },
    },
    groups: [],
    servers: [],
  }),
);

const { createApi } = await import('../src/api.js');
const { totp } = await import('../src/totp.js');

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

async function login(username, password) {
  return call('/auth/login', { method: 'POST', body: { username, password } });
}

let ownerCookie = null;

test('migração: credencial antiga vira o usuário owner e o login continua funcionando', async () => {
  const setup = await call('/setup');
  assert.equal(setup.data.needsSetup, false);

  const old = await login('owner', 'senha-legada-123');
  assert.equal(old.status, 200);
  ownerCookie = old.cookie;

  const me = await call('/auth/me', { cookie: ownerCookie });
  assert.equal(me.data.username, 'owner');
  assert.equal(me.data.role, 'owner');
});

test('usuários: owner cria admin e viewer e a listagem não expõe segredos', async () => {
  const admin = await call('/users', {
    method: 'POST',
    cookie: ownerCookie,
    body: { username: 'Operador', password: 'senha-admin-123', role: 'admin' },
  });
  assert.equal(admin.status, 201);
  assert.equal(admin.data.username, 'Operador');
  assert.equal(admin.data.role, 'admin');
  assert.equal(admin.data.passwordHash, undefined);
  assert.equal(admin.data.salt, undefined);
  assert.equal(admin.data.totp, undefined);

  const viewer = await call('/users', {
    method: 'POST',
    cookie: ownerCookie,
    body: { username: 'convidado', password: 'senha-viewer-123', role: 'viewer' },
  });
  assert.equal(viewer.status, 201);

  const list = await call('/users', { cookie: ownerCookie });
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.data.map((user) => [user.username, user.role]),
    [
      ['owner', 'owner'],
      ['Operador', 'admin'],
      ['convidado', 'viewer'],
    ],
  );

  const duplicate = await call('/users', {
    method: 'POST',
    cookie: ownerCookie,
    body: { username: 'operador', password: 'outra-senha-123', role: 'viewer' },
  });
  assert.equal(duplicate.status, 400);

  const weak = await call('/users', {
    method: 'POST',
    cookie: ownerCookie,
    body: { username: 'fraco', password: 'curta', role: 'viewer' },
  });
  assert.equal(weak.status, 400);

  const badRole = await call('/users', {
    method: 'POST',
    cookie: ownerCookie,
    body: { username: 'chefe', password: 'senha-chefe-123', role: 'root' },
  });
  assert.equal(badRole.status, 400);
});

test('papéis: viewer só lê, admin opera mas não mexe em usuários nem licença', async () => {
  const viewer = await login('convidado', 'senha-viewer-123');
  assert.equal(viewer.status, 200);
  assert.equal((await call('/groups', { cookie: viewer.cookie })).status, 200);
  assert.equal(
    (await call('/groups', { method: 'POST', cookie: viewer.cookie, body: { name: 'Proibido' } })).status,
    403,
  );
  assert.equal((await call('/users', { cookie: viewer.cookie })).status, 403);

  const admin = await login('Operador', 'senha-admin-123');
  assert.equal(admin.status, 200);
  const created = await call('/groups', {
    method: 'POST',
    cookie: admin.cookie,
    body: { name: 'Operado pelo admin' },
  });
  assert.equal(created.status, 201);
  assert.equal((await call('/users', { cookie: admin.cookie })).status, 403);
  assert.equal(
    (await call('/license', { method: 'POST', cookie: admin.cookie, body: { text: 'x' } })).status,
    403,
  );
});

test('proteções: owner não se rebaixa, não se desativa, não se exclui e o último owner fica', async () => {
  const me = await call('/auth/me', { cookie: ownerCookie });
  const selfDemote = await call(`/users/${1}`, {
    method: 'PATCH',
    cookie: ownerCookie,
    body: { role: 'viewer' },
  });
  assert.equal(selfDemote.status, 400);

  const selfDisable = await call('/users/1', {
    method: 'PATCH',
    cookie: ownerCookie,
    body: { disabled: true },
  });
  assert.equal(selfDisable.status, 400);

  const selfDelete = await call('/users/1', { method: 'DELETE', cookie: ownerCookie });
  assert.equal(selfDelete.status, 400);
  assert.equal(me.data.role, 'owner');

  // Um segundo owner pode ser rebaixado; o último não.
  const second = await call('/users', {
    method: 'POST',
    cookie: ownerCookie,
    body: { username: 'segundo', password: 'senha-segundo-123', role: 'owner' },
  });
  assert.equal(second.status, 201);
  assert.equal(
    (await call(`/users/${second.data.id}`, { method: 'PATCH', cookie: ownerCookie, body: { role: 'admin' } })).status,
    200,
  );
});

test('desativar e trocar senha derrubam as sessões do usuário', async () => {
  const created = await call('/users', {
    method: 'POST',
    cookie: ownerCookie,
    body: { username: 'temporario', password: 'senha-temp-123', role: 'viewer' },
  });
  const id = created.data.id;
  const session = await login('temporario', 'senha-temp-123');
  assert.equal(session.status, 200);
  assert.equal((await call('/servers', { cookie: session.cookie })).status, 200);

  const disabled = await call(`/users/${id}`, { method: 'PATCH', cookie: ownerCookie, body: { disabled: true } });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.disabled, true);
  assert.equal((await call('/servers', { cookie: session.cookie })).status, 401);
  assert.equal((await login('temporario', 'senha-temp-123')).status, 401);

  await call(`/users/${id}`, { method: 'PATCH', cookie: ownerCookie, body: { disabled: false } });
  const again = await login('temporario', 'senha-temp-123');
  assert.equal(again.status, 200);

  const reset = await call(`/users/${id}/password`, {
    method: 'POST',
    cookie: ownerCookie,
    body: { password: 'senha-nova-123' },
  });
  assert.equal(reset.status, 200);
  assert.equal((await call('/servers', { cookie: again.cookie })).status, 401);
  assert.equal((await login('temporario', 'senha-temp-123')).status, 401);
  assert.equal((await login('temporario', 'senha-nova-123')).status, 200);
});

test('2FA por usuário: ativa na própria conta e o owner reseta', async () => {
  const created = await call('/users', {
    method: 'POST',
    cookie: ownerCookie,
    body: { username: 'com2fa', password: 'senha-2fa-123', role: 'admin' },
  });
  const id = created.data.id;
  const session = await login('com2fa', 'senha-2fa-123');

  const setup = await call('/auth/totp/setup', { method: 'POST', cookie: session.cookie });
  assert.equal(setup.status, 200);
  const code = totp(setup.data.secret);
  const enabled = await call('/auth/totp/enable', { method: 'POST', cookie: session.cookie, body: { code } });
  assert.equal(enabled.status, 200);

  const challenge = await login('com2fa', 'senha-2fa-123');
  assert.equal(challenge.data.totpRequired, true);

  const reset = await call(`/users/${id}/totp/reset`, { method: 'POST', cookie: ownerCookie });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.totpEnabled, false);

  const plain = await login('com2fa', 'senha-2fa-123');
  assert.equal(plain.status, 200);
  assert.equal(plain.data.totpRequired, undefined);
});

test('auditoria registra o autor da ação', async () => {
  const audit = await call('/audit?limit=50', { cookie: ownerCookie });
  assert.equal(audit.status, 200);
  const created = audit.data.find((entry) => entry.action === 'user_create');
  assert.ok(created);
  assert.equal(created.actor, 'owner');
  const login = audit.data.find((entry) => entry.action === 'login');
  assert.ok(login);
  assert.ok(login.actor);
});
