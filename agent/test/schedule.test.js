import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-schedule-'));
process.env.RMC_DATA_DIR = dataDir;

const { nextDailyAt, nextIntervalAt, sanitizeAnnouncement } = await import('../src/schedule.js');
const { addServer, findServer, updateServer, ValidationError } = await import('../src/store.js');

test('nextDailyAt devolve hoje quando o horário ainda não passou e amanhã quando passou', () => {
  const from = new Date(2026, 10, 23, 12, 0, 0).getTime();

  const later = new Date(nextDailyAt('18:30', from));
  assert.equal(later.getFullYear(), 2026);
  assert.equal(later.getMonth(), 10);
  assert.equal(later.getDate(), 23);
  assert.equal(later.getHours(), 18);
  assert.equal(later.getMinutes(), 30);

  const earlier = new Date(nextDailyAt('09:00', from));
  assert.equal(earlier.getDate(), 24);
  assert.equal(earlier.getHours(), 9);

  // Exatamente no horário já conta como passado: agenda para o dia seguinte.
  const exact = new Date(nextDailyAt('12:00', from));
  assert.equal(exact.getDate(), 24);
});

test('nextIntervalAt soma o intervalo em minutos e rejeita valores inválidos', () => {
  const from = 1_700_000_000_000;
  assert.equal(nextIntervalAt(30, from), from + 30 * 60000);
  assert.equal(nextIntervalAt(1, from), from + 60000);
  assert.throws(() => nextIntervalAt(0, from), /inválido/);
  assert.throws(() => nextIntervalAt('abc', from), /inválido/);
});

test('sanitizeAnnouncement deixa uma linha só e limita o tamanho', () => {
  assert.equal(sanitizeAnnouncement('  oi\nmundo\r\n  '), 'oi mundo');
  assert.equal(sanitizeAnnouncement('x'.repeat(300)).length, 200);
  assert.equal(sanitizeAnnouncement(null), '');
});

test('store normaliza reinício, atualização e anúncios', () => {
  const server = addServer({
    identity: 'sched_local',
    mode: 'local',
    installDir: dataDir,
    restartSchedule: { enabled: true, time: '06:30', onlyIfEmpty: true },
    updateSchedule: { enabled: true, time: '05:15', restartAfter: false },
    announcements: { enabled: true, intervalMinutes: 15, messages: ['A\nB', '   ', 'C'] },
  });

  assert.deepEqual(server.restartSchedule, { enabled: true, time: '06:30', onlyIfEmpty: true });
  assert.deepEqual(server.updateSchedule, { enabled: true, time: '05:15', restartAfter: false });
  assert.deepEqual(server.announcements, {
    enabled: true,
    intervalMinutes: 15,
    messages: ['A B', 'C'],
  });

  // Atualização parcial mantém as mensagens já gravadas.
  const updated = updateServer('sched_local', { announcements: { enabled: true, intervalMinutes: 20 } });
  assert.deepEqual(updated.announcements, {
    enabled: true,
    intervalMinutes: 20,
    messages: ['A B', 'C'],
  });
  assert.equal(findServer('sched_local').announcements.intervalMinutes, 20);
});

test('store rejeita horários inválidos, modo remoto e anúncios sem mensagem', () => {
  assert.throws(
    () => addServer({ identity: 'bad_time', mode: 'local', installDir: dataDir, restartSchedule: { time: '25:00' } }),
    ValidationError,
  );
  assert.throws(
    () =>
      addServer({
        identity: 'remote_restart',
        mode: 'remote',
        host: '127.0.0.1',
        restartSchedule: { enabled: true, time: '06:00' },
      }),
    /apenas para servidores locais/,
  );
  assert.throws(
    () =>
      addServer({
        identity: 'remote_update',
        mode: 'remote',
        host: '127.0.0.1',
        updateSchedule: { enabled: true, time: '05:00' },
      }),
    /apenas para servidores locais/,
  );
  assert.throws(
    () =>
      addServer({
        identity: 'no_messages',
        mode: 'local',
        installDir: dataDir,
        announcements: { enabled: true, messages: [] },
      }),
    /ao menos uma mensagem/,
  );
  assert.throws(
    () =>
      addServer({
        identity: 'bad_interval',
        mode: 'local',
        installDir: dataDir,
        announcements: { intervalMinutes: 0 },
      }),
    /intervalMinutes/,
  );
});

test('API: agenda persistida, próximo horário no status e anúncio imediato com rotação', async () => {
  const wss = new WebSocketServer({ port: 0, path: '/senha_sched' });
  await new Promise((resolve) => wss.once('listening', resolve));
  const { port } = wss.address();
  const commands = [];

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      commands.push(message.Message);
      socket.send(
        JSON.stringify({
          Identifier: message.Identifier,
          Message: `ok: ${message.Message}`,
          Type: 'Generic',
          Name: 'Mock',
        }),
      );
    });
  });

  const { httpServer, call } = await startPanel();
  try {
    const created = await call('POST', '/api/servers', {
      identity: 'sched_api',
      mode: 'remote',
      host: '127.0.0.1',
      rconPort: port,
      rconPassword: 'senha_sched',
      autoUpdate: false,
      autoRestart: false,
      announcements: { enabled: true, intervalMinutes: 60, messages: ['primeira', 'segunda'] },
    });
    assert.equal(created.status, 201, await created.text());

    const startRes = await call('POST', '/api/servers/sched_api/start', {});
    assert.equal(startRes.status, 200, await startRes.text());
    await waitFor(async () => {
      const body = await (await call('GET', '/api/servers/sched_api')).json();
      return body.status?.state === 'running';
    }, 10000);

    const status = await (await call('GET', '/api/servers/sched_api')).json();
    assert.ok(status.status.nextAnnouncementAt > Date.now(), 'próximo anúncio não agendado');

    const first = await call('POST', '/api/servers/sched_api/announce', {});
    const firstText = await first.text();
    assert.equal(first.status, 200, firstText);
    assert.equal(JSON.parse(firstText).message, 'primeira');

    const second = await call('POST', '/api/servers/sched_api/announce', {});
    const secondText = await second.text();
    assert.equal(second.status, 200, secondText);
    assert.equal(JSON.parse(secondText).message, 'segunda');

    const manual = await call('POST', '/api/servers/sched_api/announce', { message: 'aviso manual' });
    const manualText = await manual.text();
    assert.equal(manual.status, 200, manualText);
    assert.equal(JSON.parse(manualText).message, 'aviso manual');

    assert.deepEqual(commands.filter((item) => item.startsWith('say ')), [
      'say primeira',
      'say segunda',
      'say aviso manual',
    ]);

    // Reinício agendado não existe em servidor remoto.
    const remoteRestart = await call('PATCH', '/api/servers/sched_api', {
      restartSchedule: { enabled: true, time: '06:00' },
    });
    assert.equal(remoteRestart.status, 400, await remoteRestart.text());

    // Servidor local: o status expõe o próximo reinício e a próxima atualização.
    const local = await call('POST', '/api/servers', {
      identity: 'sched_local_api',
      mode: 'local',
      installDir: dataDir,
      restartSchedule: { enabled: true, time: '06:30' },
      updateSchedule: { enabled: true, time: '05:15' },
    });
    const localText = await local.text();
    assert.equal(local.status, 201, localText);
    const localBody = JSON.parse(localText);    assert.ok(localBody.status.nextRestartAt > Date.now());
    assert.ok(localBody.status.nextUpdateAt > Date.now());

    await call('POST', '/api/servers/sched_api/stop', {});
  } finally {
    for (const client of wss.clients) client.terminate();
    httpServer.closeAllConnections?.();
    httpServer.close();
    await new Promise((resolve) => wss.close(resolve));
  }
});

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('tempo esgotado esperando a condição');
}

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
    body: JSON.stringify({ password: 'senha-sched-forte' }),
  });
  let cookie = '';
  if (setupRes.ok) {
    cookie = (setupRes.headers.get('set-cookie') ?? '').split(';')[0];
  } else {
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'senha-sched-forte' }),
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
