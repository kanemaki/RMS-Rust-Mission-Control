import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-groups-'));
process.env.RMC_DATA_DIR = dataDir;

const here = path.dirname(fileURLToPath(import.meta.url));
const rustdsDir = path.join(dataDir, 'rustds');
fs.mkdirSync(rustdsDir, { recursive: true });

const {
  addGroup,
  addServer,
  listGroups,
  normalizeServer,
  reloadConfig,
  removeGroup,
  updateGroup,
  ValidationError,
} = await import('../src/store.js');

test('grupos: criar, listar com contagem, renomear e rejeitar nome duplicado', () => {
  const group = addGroup({ name: 'Produção' });
  assert.ok(group.id);
  assert.equal(group.name, 'Produção');
  assert.equal(group.count, 0);
  // Nome duplicado é case-insensitive para não criar pares confusos no painel.
  assert.throws(() => addGroup({ name: 'produção' }), ValidationError);
  assert.throws(() => addGroup({ name: '   ' }), ValidationError);

  const renamed = updateGroup(group.id, { name: 'Servidores de produção' });
  assert.equal(renamed.name, 'Servidores de produção');
  assert.equal(updateGroup('grupo-que-nao-existe', { name: 'x' }), null);
});

test('grupos: excluir desassocia servidores e referência inválida é rejeitada', () => {
  const group = addGroup({ name: 'Testes' });
  const server = addServer({ identity: 'grp_srv', installDir: rustdsDir, group: group.id });
  assert.equal(server.group, group.id);
  assert.equal(listGroups().find((item) => item.id === group.id)?.count, 1);

  assert.throws(
    () => addServer({ identity: 'grp_srv2', installDir: rustdsDir, group: 'grupo-fantasma' }),
    ValidationError,
  );

  assert.equal(removeGroup(group.id), true);
  const after = reloadConfig().servers.find((item) => item.id === 'grp_srv');
  assert.equal(after.group, null);
  assert.equal(listGroups().some((item) => item.id === group.id), false);
});

test('grupos sobrevivem ao reload do config (whitelist do normalizeConfig)', () => {
  const group = addGroup({ name: 'Persistente' });
  reloadConfig();
  assert.ok(listGroups().some((item) => item.id === group.id));
});

test('normalizeServer trata group vazio, nulo e formato inválido', () => {
  const base = { identity: 'grp_norm', installDir: rustdsDir };
  assert.equal(normalizeServer({ ...base }).group, null);
  assert.equal(normalizeServer({ ...base, group: '' }).group, null);
  assert.equal(normalizeServer({ ...base, group: null }).group, null);
  assert.equal(normalizeServer({ ...base, group: 'abc-123' }).group, 'abc-123');
  assert.throws(() => normalizeServer({ ...base, group: 'id com espaço!' }), ValidationError);
  assert.throws(() => normalizeServer({ ...base, group: 42 }), ValidationError);
});

/** Sobe a API in-process e devolve um helper autenticado para chamá-la. */
async function startPanel() {
  const { default: express } = await import('express');
  const { createApi } = await import('../src/api.js');
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', createApi({ secureCookies: false }));
  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => httpServer.once('listening', resolve));
  const base = `http://127.0.0.1:${httpServer.address().port}`;

  const setupRes = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'senha-groups-forte' }),
  });
  let cookie = '';
  if (setupRes.ok) {
    cookie = (setupRes.headers.get('set-cookie') ?? '').split(';')[0];
  } else {
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'senha-groups-forte' }),
    });
    cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
  }
  assert.ok(cookie, 'sessão não recebida');

  const call = (method, apiPath, body) =>
    fetch(`${base}${apiPath}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        cookie,
        ...(method === 'GET' ? {} : { 'x-rmc-request': '1' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { httpServer, call };
}

test('rotas de grupos: CRUD com contagem e desassociação no delete', async () => {
  const { httpServer, call } = await startPanel();
  try {
    const createRes = await call('POST', '/api/groups', { name: 'API Grupo' });
    assert.equal(createRes.status, 201);
    const group = await createRes.json();
    assert.ok(group.id);

    for (const identity of ['api_grp_a', 'api_grp_b']) {
      const res = await call('POST', '/api/servers', { identity, installDir: rustdsDir, group: group.id });
      assert.equal(res.status, 201, await res.text());
    }

    const groups = await (await call('GET', '/api/groups')).json();
    assert.equal(groups.find((item) => item.id === group.id)?.count, 2);

    const patchRes = await call('PATCH', `/api/groups/${group.id}`, { name: 'API Renomeado' });
    assert.equal(patchRes.status, 200);
    assert.equal((await patchRes.json()).name, 'API Renomeado');

    const missing = await call('PATCH', '/api/groups/nao-existe', { name: 'x' });
    assert.equal(missing.status, 404);

    const delRes = await call('DELETE', `/api/groups/${group.id}`);
    assert.equal(delRes.status, 200);

    const servers = await (await call('GET', '/api/servers')).json();
    for (const identity of ['api_grp_a', 'api_grp_b']) {
      assert.equal(servers.find((item) => item.id === identity)?.group, null);
    }
  } finally {
    httpServer.close();
  }
});

test('lote: valida entrada e agrega falhas por servidor', async () => {
  const { httpServer, call } = await startPanel();
  try {
    const badAction = await call('POST', '/api/servers/batch', { ids: ['x'], action: 'wipe' });
    assert.equal(badAction.status, 400);
    const noIds = await call('POST', '/api/servers/batch', { ids: [], action: 'stop' });
    assert.equal(noIds.status, 400);
    const badIds = await call('POST', '/api/servers/batch', { ids: [null, '  '], action: 'stop' });
    assert.equal(badIds.status, 400);

    const res = await call('POST', '/api/servers/batch', { ids: ['fantasma_a', 'fantasma_b'], action: 'stop' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 2);
    assert.equal(body.succeeded, 0);
    assert.equal(body.failed, 2);
    assert.ok(body.results.every((item) => !item.ok && item.error === 'Servidor não encontrado.'));
  } finally {
    httpServer.close();
  }
});

test('lote: inicia e para dois servidores simulados em paralelo', async () => {
  const { httpServer, call } = await startPanel();
  try {
    const mocks = [
      ['batch_a', 28931],
      ['batch_b', 28932],
    ];
    for (const [identity, rconPort] of mocks) {
      const res = await call('POST', '/api/servers', {
        identity,
        installDir: rustdsDir,
        executable: process.execPath,
        executableArgs: [path.join(here, 'mock-server.js')],
        autoUpdate: false,
        autoRestart: false,
        rconPort,
      });
      assert.equal(res.status, 201, await res.text());
    }

    const startRes = await call('POST', '/api/servers/batch', { ids: mocks.map(([id]) => id), action: 'start' });
    assert.equal(startRes.status, 200);
    const startBody = await startRes.json();
    assert.equal(startBody.succeeded, 2, JSON.stringify(startBody));
    assert.ok(
      startBody.results.every((item) => item.status.state === 'starting' || item.status.state === 'running'),
    );

    const { runtimeManager } = await import('../src/process-manager.js');
    await waitFor(
      () =>
        runtimeManager.get('batch_a')?.state === 'running' && runtimeManager.get('batch_b')?.state === 'running',
      15000,
    );

    const stopRes = await call('POST', '/api/servers/batch', { ids: mocks.map(([id]) => id), action: 'stop' });
    const stopBody = await stopRes.json();
    assert.equal(stopBody.succeeded, 2, JSON.stringify(stopBody));
    assert.ok(
      stopBody.results.every((item) => item.status.state === 'stopped' || item.status.state === 'stopping'),
    );
    await waitFor(
      () =>
        runtimeManager.get('batch_a')?.state === 'stopped' && runtimeManager.get('batch_b')?.state === 'stopped',
      15000,
    );
  } finally {
    httpServer.close();
  }
});

test('lote: backup falha por item quando não há save ou o servidor é remoto', async () => {
  const { httpServer, call } = await startPanel();
  try {
    const local = await call('POST', '/api/servers', { identity: 'batch_local', installDir: rustdsDir });
    assert.equal(local.status, 201, await local.text());
    const remote = await call('POST', '/api/servers', {
      identity: 'batch_remote',
      mode: 'remote',
      host: '127.0.0.1',
      rconPort: 28933,
    });
    assert.equal(remote.status, 201, await remote.text());

    const res = await call('POST', '/api/servers/batch', {
      ids: ['batch_local', 'batch_remote'],
      action: 'backup',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.succeeded, 0);
    assert.equal(body.failed, 2);

    const localResult = body.results.find((item) => item.id === 'batch_local');
    assert.ok(!localResult.ok);
    assert.match(localResult.error, /pasta da identidade/);

    const remoteResult = body.results.find((item) => item.id === 'batch_remote');
    assert.ok(!remoteResult.ok);
    assert.equal(remoteResult.error, 'Backup disponível apenas para servidores locais.');
  } finally {
    httpServer.close();
  }
});

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timeout esperando condição');
}
