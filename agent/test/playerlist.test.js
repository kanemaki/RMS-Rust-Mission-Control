import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlayerList } from '../src/playerlist.js';

const REAL = JSON.stringify([
  {
    SteamID: '76561198876519753',
    OwnerSteamID: '0',
    DisplayName: 'Buiuia',
    Ping: 0,
    Address: '127.0.0.1:63422',
    EntityId: 138485,
    ConnectedSeconds: 302,
    ViolationLevel: 0.0,
    CurrentLevel: 0.0,
    Health: 68.1273,
    Position: { x: -1339.09216, y: 15.2705441, z: -723.5207 },
    IsMuted: false,
    TeamID: 0,
  },
]);

test('interpreta o array JSON real do playerlist', () => {
  const parsed = parsePlayerList(REAL);
  assert.equal(parsed.players, 1);
  assert.deepEqual(parsed.names, ['Buiuia']);
});

test('array vazio significa zero jogadores', () => {
  const parsed = parsePlayerList('[]');
  assert.equal(parsed.players, 0);
  assert.deepEqual(parsed.names, []);
});

test('conta múltiplos jogadores e ignora nomes vazios', () => {
  const parsed = parsePlayerList(
    JSON.stringify([{ DisplayName: 'A' }, { DisplayName: 'B' }, { DisplayName: '' }, { SteamID: '1' }]),
  );
  assert.equal(parsed.players, 4);
  assert.deepEqual(parsed.names, ['A', 'B']);
});

test('aceita formato de texto com máximo', () => {
  assert.deepEqual(parsePlayerList('Players: 3 / 50'), { players: 3, maxPlayers: 50, names: [] });
  assert.deepEqual(parsePlayerList('3 / 50'), { players: 3, maxPlayers: 50, names: [] });
});

test('aceita lista de steamids sem rótulo', () => {
  const parsed = parsePlayerList('76561198876519753\n76561198000000001');
  assert.equal(parsed.players, 2);
});

test('resposta vazia ou irreconhecível devolve null', () => {
  assert.equal(parsePlayerList(''), null);
  assert.equal(parsePlayerList('   '), null);
  assert.equal(parsePlayerList('ok'), null);
  assert.equal(parsePlayerList(null), null);
});
