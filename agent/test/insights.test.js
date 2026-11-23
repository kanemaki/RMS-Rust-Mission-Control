import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-insights-'));
process.env.RMC_DATA_DIR = dataDir;

const {
  heatmap,
  inactivePlayers,
  normalizeDays,
  playerStats,
  playersCsv,
  serverInsights,
  sessionMs,
  sessionsCsv,
} = await import('../src/insights.js');
const { trackPlayers } = await import('../src/players.js');
const { getDb } = await import('../src/db.js');
const { ValidationError } = await import('../src/errors.js');

const ALICE = '76561198000000011';
const BOB = '76561198000000012';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Sexta-feira, 20/11/2026, 10:00 no horário local.
const BASE = new Date(2026, 10, 20, 10, 0, 0).getTime();

function seed(serverId) {
  trackPlayers(serverId, [{ steamId: ALICE, name: 'Alice' }], BASE);
  trackPlayers(serverId, [], BASE + 2 * HOUR);
  trackPlayers(serverId, [{ steamId: ALICE, name: 'Alice' }], BASE + 3 * HOUR);
  trackPlayers(serverId, [], BASE + 4 * HOUR);
  trackPlayers(serverId, [{ steamId: BOB, name: 'Bob' }], BASE + 3 * HOUR);
  trackPlayers(serverId, [], BASE + 4 * HOUR);
}

test('normalizeDays valida o período', () => {
  assert.equal(normalizeDays(undefined, 30), 30);
  assert.equal(normalizeDays('7'), 7);
  assert.throws(() => normalizeDays(0), ValidationError);
  assert.throws(() => normalizeDays(400), ValidationError);
});

test('sessionMs usa left_at, last_seen e nunca passa de agora', () => {
  assert.equal(sessionMs({ joined_at: BASE, left_at: BASE + HOUR }, BASE + 5 * HOUR), HOUR);
  assert.equal(sessionMs({ joined_at: BASE, left_at: null, last_seen: BASE + 30 * 60000 }, BASE + 5 * HOUR), 30 * 60000);
  assert.equal(sessionMs({ joined_at: BASE, left_at: BASE + 10 * HOUR }, BASE + HOUR), HOUR);
  assert.equal(sessionMs({ joined_at: BASE, left_at: BASE - HOUR }, BASE), 0);
});

test('playerStats soma tempo total, hoje, semana e média por sessão', () => {
  seed('srv_stats');
  const stats = playerStats('srv_stats', ALICE, BASE + 5 * HOUR);
  assert.equal(stats.sessions, 2);
  assert.equal(stats.totalMs, 3 * HOUR);
  assert.equal(stats.todayMs, 3 * HOUR);
  assert.equal(stats.weekMs, 3 * HOUR);
  assert.equal(stats.monthMs, 3 * HOUR);
  assert.equal(stats.avgSessionMs, 1.5 * HOUR);
  assert.equal(stats.activeDays, 1);
  assert.equal(stats.sessionCount, 2);
});

test('heatmap distribui o tempo por dia da semana e hora local', () => {
  const map = heatmap('srv_stats', { days: 30, now: BASE + 5 * HOUR });
  const cell = (weekday, hour) => map.cells.find((item) => item.weekday === weekday && item.hour === hour);
  // 20/11/2026 é sexta: ISO 4 (segunda = 0). A sessão 10:00→12:00 ocupa as duas horas.
  assert.equal(cell(4, 10).ms, HOUR);
  assert.equal(cell(4, 11).ms, HOUR);
  assert.equal(cell(4, 10).sessions, 1);
  assert.equal(cell(4, 13).ms, 2 * HOUR);
  assert.equal(map.peakMs, 2 * HOUR);
  assert.equal(map.totalMs, 4 * HOUR);
  assert.equal(map.cells.length, 7 * 24);
});

test('serverInsights traz totais, ranking e retenção', () => {
  const db = getDb();
  db.prepare('UPDATE players SET first_seen = ? WHERE server_id = ? AND steam_id = ?').run(
    BASE - 60 * DAY,
    'srv_stats',
    BOB,
  );
  const data = serverInsights('srv_stats', { days: 30, inactiveDays: 14, now: BASE + 5 * HOUR });
  assert.equal(data.totals.players, 2);
  assert.equal(data.totals.sessions, 3);
  assert.equal(data.totals.totalMs, 4 * HOUR);
  assert.equal(data.totals.activeToday, 2);
  assert.equal(data.totals.newPlayers, 1);
  assert.equal(data.totals.returningPlayers, 1);
  assert.equal(data.topByTime[0].steamId, ALICE);
  assert.equal(data.topByTime[0].ms, 3 * HOUR);
  assert.equal(data.topBySessions[0].sessions, 2);
  assert.equal(data.retention.newPlayers[0].steamId, ALICE);
  assert.equal(data.heatmap.cells.length, 168);
});

test('inactivePlayers lista quem sumiu e ignora quem está online', () => {
  const db = getDb();
  db.prepare('UPDATE players SET last_seen = ? WHERE server_id = ? AND steam_id = ?').run(
    BASE - 20 * DAY,
    'srv_stats',
    BOB,
  );
  const list = inactivePlayers('srv_stats', 14, BASE + 5 * HOUR);
  assert.equal(list.length, 1);
  assert.equal(list[0].steamId, BOB);
  assert.equal(list[0].daysAgo, 20);

  trackPlayers('srv_stats', [{ steamId: BOB, name: 'Bob' }], BASE + 6 * HOUR);
  assert.equal(inactivePlayers('srv_stats', 14, BASE + 6 * HOUR).length, 0);
});

test('CSV de jogadores e sessões escapa campos e calcula duração', () => {
  const db = getDb();
  db.prepare('UPDATE players SET note = ? WHERE server_id = ? AND steam_id = ?').run(
    'usa "aspas", vírgula',
    'srv_stats',
    ALICE,
  );
  const players = playersCsv('srv_stats');
  assert.match(players, /steam_id,name,online,first_seen,last_seen,session_count,note/);
  assert.match(players, new RegExp(ALICE));
  assert.match(players, /"usa ""aspas"", vírgula"/);

  const sessions = sessionsCsv('srv_stats');
  assert.match(sessions, /steam_id,name,joined_at,left_at,duration_minutes/);
  assert.match(sessions, /,120\r\n/);
});
