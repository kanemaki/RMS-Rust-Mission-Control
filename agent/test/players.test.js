import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-players-'));
process.env.RMC_DATA_DIR = dataDir;

const {
  closeAllSessions,
  closeSessions,
  dueBans,
  getPlayer,
  latestStates,
  listModeration,
  listPlayers,
  normalizeSteamId,
  recordModeration,
  resolveBans,
  setPlayerNote,
  trackPlayers,
} = await import('../src/players.js');
const { listChat, matchChatRule, parseChatMessage, recordChat } = await import('../src/chat.js');
const { normalizeChatFilter, ValidationError } = await import('../src/store.js');

const ALICE = '76561198000000001';
const BOB = '76561198000000002';

test('rastreia entrada, saída e retorno de jogadores', () => {
  trackPlayers('srv_track', [
    { steamId: ALICE, name: 'Alice', ping: 20 },
    { steamId: BOB, name: 'Bob', ping: 30 },
  ]);
  let players = listPlayers('srv_track');
  assert.equal(players.online.length, 2);
  assert.equal(players.online.find((item) => item.steamId === ALICE)?.sessionCount, 1);

  trackPlayers('srv_track', [{ steamId: ALICE, name: 'Alice', ping: 25 }]);
  players = listPlayers('srv_track');
  assert.equal(players.online.length, 1);
  assert.equal(players.recent.find((item) => item.steamId === BOB)?.online, false);

  trackPlayers('srv_track', [
    { steamId: ALICE, name: 'Alice', ping: 25 },
    { steamId: BOB, name: 'Bob', ping: 40 },
  ]);
  const bob = getPlayer('srv_track', BOB);
  assert.equal(bob.sessionCount, 2);
  assert.equal(bob.sessions.length, 2);
  assert.equal(bob.sessions.filter((session) => session.left_at === null).length, 1);
});

test('lista vazia e parada do servidor fecham as sessões abertas', () => {
  trackPlayers('srv_empty', [
    { steamId: ALICE, name: 'Alice' },
    { steamId: BOB, name: 'Bob' },
  ]);
  assert.equal(listPlayers('srv_empty').online.length, 2);

  // playerlist estruturado vazio: ninguém online, sessões precisam fechar.
  trackPlayers('srv_empty', []);
  let players = listPlayers('srv_empty');
  assert.equal(players.online.length, 0);
  assert.equal(players.recent.length, 2);

  // Servidor parado sem passar pelo playerlist: closeSessions fecha tudo.
  trackPlayers('srv_empty', [{ steamId: ALICE, name: 'Alice' }]);
  assert.equal(listPlayers('srv_empty').online.length, 1);
  assert.equal(closeSessions('srv_empty').closed, 1);
  players = listPlayers('srv_empty');
  assert.equal(players.online.length, 0);
  assert.equal(closeSessions('srv_empty').closed, 0);
});

test('boot do agente fecha sessões abertas de todos os servidores', () => {
  trackPlayers('srv_boot_a', [{ steamId: ALICE, name: 'Alice' }]);
  trackPlayers('srv_boot_b', [{ steamId: BOB, name: 'Bob' }]);
  assert.equal(listPlayers('srv_boot_a').online.length, 1);
  assert.equal(listPlayers('srv_boot_b').online.length, 1);

  assert.ok(closeAllSessions().closed >= 2);
  assert.equal(listPlayers('srv_boot_a').online.length, 0);
  assert.equal(listPlayers('srv_boot_b').online.length, 0);
  assert.equal(closeAllSessions().closed, 0);
});

test('notas do jogador são gravadas e limitadas', () => {
  trackPlayers('srv_note', [{ steamId: ALICE, name: 'Alice' }]);
  setPlayerNote('srv_note', ALICE, '  suspeito de cheat  ');
  assert.equal(getPlayer('srv_note', ALICE).note, 'suspeito de cheat');
  setPlayerNote('srv_note', ALICE, 'x'.repeat(3000));
  assert.equal(getPlayer('srv_note', ALICE).note.length, 2000);
  assert.throws(() => normalizeSteamId('123'), ValidationError);
});

test('histórico de moderação, estado atual e expiração de ban', () => {
  const now = Date.now();
  recordModeration({
    serverId: 'srv_mod',
    steamId: ALICE,
    name: 'Alice',
    action: 'mute',
    reason: 'spam',
    ts: now - 2000,
  });
  recordModeration({
    serverId: 'srv_mod',
    steamId: ALICE,
    name: 'Alice',
    action: 'ban',
    reason: 'cheat',
    minutes: 10,
    expiresAt: now - 1000,
    ts: now - 1000,
  });
  const state = latestStates('srv_mod').get(ALICE);
  assert.equal(state.muted, false);
  assert.equal(state.banned, false);
  assert.equal(state.lastAction, 'ban');

  const due = dueBans('srv_mod', now);
  assert.equal(due.length, 1);
  assert.equal(due[0].steamId, ALICE);
  resolveBans('srv_mod', ALICE, now);
  assert.equal(dueBans('srv_mod', now).length, 0);
  assert.equal(listModeration('srv_mod', { steamId: ALICE }).length, 2);
});

test('super usuário: owner/unowner independentes do último mute ou ban', () => {
  const now = Date.now();
  trackPlayers('srv_owner', [{ steamId: ALICE, name: 'Alice' }]);
  recordModeration({ serverId: 'srv_owner', steamId: ALICE, name: 'Alice', action: 'owner', ts: now - 3000 });
  recordModeration({ serverId: 'srv_owner', steamId: ALICE, name: 'Alice', action: 'mute', ts: now - 2000 });

  let state = latestStates('srv_owner').get(ALICE);
  assert.equal(state.owner, true);
  assert.equal(state.muted, true);
  assert.equal(state.lastAction, 'mute');
  assert.equal(getPlayer('srv_owner', ALICE).owner, true);

  recordModeration({ serverId: 'srv_owner', steamId: ALICE, name: 'Alice', action: 'unowner', ts: now - 1000 });
  state = latestStates('srv_owner').get(ALICE);
  assert.equal(state.owner, false);
  assert.equal(state.ownerSince, null);
  assert.equal(state.lastAction, 'unowner');
  assert.equal(getPlayer('srv_owner', ALICE).owner, false);
});

test('chat: parsing, regra por palavra-chave e histórico sinalizado', () => {
  const parsed = parseChatMessage({
    Type: 'Chat',
    Message: JSON.stringify({
      Channel: 0,
      Message: 'voce e um badword',
      UserId: ALICE,
      Username: 'Alice',
    }),
  });
  assert.deepEqual(parsed, { steamId: ALICE, username: 'Alice', text: 'voce e um badword', channel: 0 });
  assert.equal(parseChatMessage({ Type: 'Chat', Message: '' }), null);
  assert.equal(matchChatRule('BADWORD aqui', ['badword']), 'badword');
  assert.equal(matchChatRule('tudo limpo', ['badword']), null);

  const filter = normalizeChatFilter({ enabled: true, keywords: [' badword ', 'BADWORD', ''] });
  assert.deepEqual(filter.keywords, ['badword']);

  const entry = recordChat({
    serverId: 'srv_chat',
    steamId: ALICE,
    username: 'Alice',
    text: 'voce e um badword',
    filter,
  });
  assert.equal(entry.flagged, true);
  assert.equal(entry.rule, 'badword');
  recordChat({ serverId: 'srv_chat', steamId: BOB, username: 'Bob', text: 'oi', filter });
  assert.equal(listChat('srv_chat').length, 2);
  assert.equal(listChat('srv_chat', { flagged: true }).length, 1);
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
    body: JSON.stringify({ password: 'senha-players-forte' }),
  });
  let cookie = '';
  if (setupRes.ok) {
    cookie = (setupRes.headers.get('set-cookie') ?? '').split(';')[0];
  } else {
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'senha-players-forte' }),
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

test('API: jogadores, notas, ações, chat e filtro de chat', async () => {
  const wss = new WebSocketServer({ port: 0, path: '/senha_players' });
  await new Promise((resolve) => wss.once('listening', resolve));
  const { port } = wss.address();
  const commands = [];

  wss.on('connection', (socket) => {
    socket.send(
      JSON.stringify({
        Identifier: 0,
        Type: 'Chat',
        Message: JSON.stringify({
          Channel: 0,
          Message: 'ola badword',
          UserId: ALICE,
          Username: 'Alice',
        }),
        Name: 'Mock',
      }),
    );
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      commands.push(message.Message);
      const reply = /^playerlist/i.test(message.Message)
        ? JSON.stringify([
            { SteamID: ALICE, DisplayName: 'Alice', Ping: 20 },
            { SteamID: BOB, DisplayName: 'Bob', Ping: 30 },
          ])
        : `ok: ${message.Message}`;
      socket.send(
        JSON.stringify({ Identifier: message.Identifier, Message: reply, Type: 'Generic', Name: 'Mock' }),
      );
    });
  });

  const { httpServer, call } = await startPanel();
  try {
    const created = await call('POST', '/api/servers', {
      identity: 'players_api',
      mode: 'remote',
      host: '127.0.0.1',
      rconPort: port,
      rconPassword: 'senha_players',
      autoUpdate: false,
      autoRestart: false,
      chatFilter: { enabled: true, keywords: ['badword'], notifyDiscord: false },
    });
    assert.equal(created.status, 201, await created.text());

    const startRes = await call('POST', '/api/servers/players_api/start', {});
    assert.equal(startRes.status, 200, await startRes.text());

    await waitFor(async () => {
      const body = await (await call('GET', '/api/servers/players_api/players')).json();
      return body.online?.length === 2;
    }, 10000);

    const list = await (await call('GET', '/api/servers/players_api/players')).json();
    assert.equal(list.online.length, 2);

    const detail = await (await call('GET', `/api/servers/players_api/players/${ALICE}`)).json();
    assert.equal(detail.name, 'Alice');
    assert.equal(detail.sessions.length, 1);

    const noteRes = await call('PATCH', `/api/servers/players_api/players/${ALICE}`, { note: 'amigo do admin' });
    assert.equal(noteRes.status, 200);
    assert.equal((await noteRes.json()).note, 'amigo do admin');

    const kick = await call('POST', `/api/servers/players_api/players/${ALICE}/action`, {
      action: 'kick',
      reason: 'teste',
    });
    const kickText = await kick.text();
    assert.equal(kick.status, 200, kickText);
    assert.match(JSON.parse(kickText).response, /kick/);

    const ban = await call('POST', `/api/servers/players_api/players/${ALICE}/action`, {
      action: 'ban',
      reason: 'cheat',
      minutes: 60,
      sync: true,
    });
    const banText = await ban.text();
    assert.equal(ban.status, 200, banText);
    const banBody = JSON.parse(banText);
    assert.equal(banBody.moderation.action, 'ban');
    assert.ok(banBody.moderation.expiresAt > Date.now());
    assert.equal(banBody.sync.total, 0);

    const owner = await call('POST', `/api/servers/players_api/players/${ALICE}/action`, {
      action: 'owner',
      reason: 'amigo do admin',
    });
    const ownerText = await owner.text();
    assert.equal(owner.status, 200, ownerText);
    assert.match(JSON.parse(ownerText).response, /ownerid/);
    assert.equal((await (await call('GET', `/api/servers/players_api/players/${ALICE}`)).json()).owner, true);

    const unowner = await call('POST', `/api/servers/players_api/players/${ALICE}/action`, {
      action: 'unowner',
    });
    const unownerText = await unowner.text();
    assert.equal(unowner.status, 200, unownerText);
    assert.match(JSON.parse(unownerText).response, /removeowner/);
    assert.equal((await (await call('GET', `/api/servers/players_api/players/${ALICE}`)).json()).owner, false);

    const moderation = await (await call('GET', '/api/servers/players_api/moderation')).json();
    assert.equal(moderation.length, 4);

    await waitFor(async () => {
      const chat = await (await call('GET', '/api/servers/players_api/chat?flagged=1')).json();
      return chat.length === 1;
    }, 10000);
    const flagged = await (await call('GET', '/api/servers/players_api/chat?flagged=1')).json();
    assert.equal(flagged[0].rule, 'badword');

    const filterRes = await call('PUT', '/api/servers/players_api/chat-filter', {
      enabled: true,
      keywords: ['badword', 'spam'],
      notifyDiscord: false,
    });
    assert.equal(filterRes.status, 200);
    assert.deepEqual((await filterRes.json()).keywords, ['badword', 'spam']);

    const say = await call('POST', '/api/servers/players_api/chat', { message: 'aviso do admin' });
    assert.equal(say.status, 200, await say.text());
    assert.ok(commands.some((command) => command === 'say aviso do admin'));

    const missing = await call('GET', '/api/servers/players_api/players/76561198000000009');
    assert.equal(missing.status, 404);

    await call('POST', '/api/servers/players_api/stop', {});

    // Servidor parado: a listagem não pode continuar mostrando ninguém online.
    const stopped = await (await call('GET', '/api/servers/players_api/players')).json();
    assert.equal(stopped.online.length, 0);
    assert.equal(stopped.recent.length, 2);
    const stoppedDetail = await (await call('GET', `/api/servers/players_api/players/${ALICE}`)).json();
    assert.equal(stoppedDetail.online, false);
  } finally {
    for (const client of wss.clients) client.terminate();
    httpServer.close();
    await new Promise((resolve) => wss.close(resolve));
  }
});

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timeout esperando condição');
}
