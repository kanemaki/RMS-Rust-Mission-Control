import { getDb } from './db.js';
import { ValidationError } from './errors.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 365;
const MAX_CSV_ROWS = 20000;

export function normalizeDays(value, fallback = 30) {
  if (value === null || value === undefined || value === '') return fallback;
  const days = Number.parseInt(value, 10);
  if (!Number.isFinite(days) || days < 1 || days > MAX_DAYS) {
    throw new ValidationError(`O período deve ser entre 1 e ${MAX_DAYS} dias.`);
  }
  return days;
}

/** Duração de uma sessão em ms. Sessão aberta usa o último poll (ou agora). */
export function sessionMs(session, now = Date.now()) {
  const start = Number(session.joined_at) || 0;
  const rawEnd = session.left_at ?? session.last_seen ?? now;
  const end = Math.min(Math.max(Number(rawEnd) || start, start), now);
  return Math.max(0, end - start);
}

function overlapMs(start, end, from, to) {
  const left = Math.max(start, from);
  const right = Math.min(end, to);
  return Math.max(0, right - left);
}

function startOfDay(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function sessionsOf(serverId, steamId = null) {
  const db = getDb();
  return steamId
    ? db
        .prepare(
          `SELECT joined_at, left_at, last_seen FROM player_sessions
           WHERE server_id = ? AND steam_id = ? ORDER BY joined_at ASC`,
        )
        .all(serverId, steamId)
    : db
        .prepare(
          `SELECT steam_id, joined_at, left_at, last_seen FROM player_sessions
           WHERE server_id = ? ORDER BY joined_at ASC`,
        )
        .all(serverId);
}

/**
 * Tempo de jogo de um jogador: total, hoje, 7 e 30 dias, média por sessão e
 * dias ativos. Tudo calculado das sessões já gravadas, sem tabela nova.
 */
export function playerStats(serverId, steamId, now = Date.now()) {
  const db = getDb();
  const player = db
    .prepare('SELECT first_seen, last_seen, session_count FROM players WHERE server_id = ? AND steam_id = ?')
    .get(serverId, steamId);
  const sessions = sessionsOf(serverId, steamId);

  let totalMs = 0;
  let todayMs = 0;
  let weekMs = 0;
  let monthMs = 0;
  const activeDays = new Set();
  const todayStart = startOfDay(now);

  for (const session of sessions) {
    const start = Number(session.joined_at) || 0;
    const end = Math.min(
      Math.max(Number(session.left_at ?? session.last_seen ?? now) || start, start),
      now,
    );
    const duration = Math.max(0, end - start);
    totalMs += duration;
    todayMs += overlapMs(start, end, todayStart, now);
    weekMs += overlapMs(start, end, now - 7 * DAY_MS, now);
    monthMs += overlapMs(start, end, now - 30 * DAY_MS, now);
    if (duration > 0) activeDays.add(startOfDay(start));
  }

  return {
    steamId,
    totalMs,
    todayMs,
    weekMs,
    monthMs,
    avgSessionMs: sessions.length ? Math.round(totalMs / sessions.length) : 0,
    sessions: sessions.length,
    activeDays: activeDays.size,
    firstSeen: player?.first_seen ?? null,
    lastSeen: player?.last_seen ?? null,
    sessionCount: player?.session_count ?? sessions.length,
  };
}

/**
 * Heatmap de atividade: dia da semana (0 = segunda) × hora local, com o tempo
 * de jogo distribuído pelas horas que a sessão realmente ocupou.
 */
export function heatmap(serverId, { days = 30, now = Date.now() } = {}) {
  const range = normalizeDays(days, 30);
  const since = now - range * DAY_MS;
  const db = getDb();
  const sessions = db
    .prepare(
      `SELECT joined_at, left_at, last_seen FROM player_sessions
       WHERE server_id = ? AND joined_at <= ? AND (left_at IS NULL OR left_at >= ?)`,
    )
    .all(serverId, now, since);

  const grid = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ ms: 0, sessions: 0 })),
  );

  for (const session of sessions) {
    const start = Math.max(Number(session.joined_at) || 0, since);
    const rawEnd = Number(session.left_at ?? session.last_seen ?? now) || start;
    const end = Math.min(Math.max(rawEnd, start), now);
    if (end <= start) continue;

    const first = new Date(start);
    grid[(first.getDay() + 6) % 7][first.getHours()].sessions += 1;

    let cursor = start;
    let guard = 0;
    while (cursor < end && guard < 9000) {
      const d = new Date(cursor);
      const nextHour = new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        d.getHours() + 1,
        0,
        0,
        0,
      ).getTime();
      const segmentEnd = Math.min(end, nextHour);
      grid[(d.getDay() + 6) % 7][d.getHours()].ms += segmentEnd - cursor;
      cursor = segmentEnd;
      guard += 1;
    }
  }

  const cells = [];
  let peakMs = 0;
  let totalMs = 0;
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const cell = grid[weekday][hour];
      peakMs = Math.max(peakMs, cell.ms);
      totalMs += cell.ms;
      cells.push({ weekday, hour, ms: cell.ms, sessions: cell.sessions });
    }
  }

  return { days: range, since, until: now, cells, peakMs, totalMs };
}

/** Jogadores que não entram há pelo menos `days` dias e não estão online agora. */
export function inactivePlayers(serverId, days = 14, now = Date.now()) {
  const range = normalizeDays(days, 14);
  const cutoff = now - range * DAY_MS;
  const rows = getDb()
    .prepare(
      `SELECT p.steam_id, p.name, p.last_seen FROM players p
       WHERE p.server_id = ? AND p.last_seen < ?
         AND NOT EXISTS (
           SELECT 1 FROM player_sessions s
           WHERE s.server_id = p.server_id AND s.steam_id = p.steam_id AND s.left_at IS NULL
         )
       ORDER BY p.last_seen DESC`,
    )
    .all(serverId, cutoff);
  return rows.map((row) => ({
    steamId: row.steam_id,
    name: row.name,
    lastSeen: row.last_seen,
    daysAgo: Math.floor((now - row.last_seen) / DAY_MS),
  }));
}

/**
 * Painel de inteligência: totais do período, heatmap, ranking e retenção.
 */
export function serverInsights(serverId, { days = 30, inactiveDays = 14, now = Date.now() } = {}) {
  const range = normalizeDays(days, 30);
  const inactiveRange = normalizeDays(inactiveDays, 14);
  const since = now - range * DAY_MS;
  const db = getDb();

  const players = db
    .prepare(
      `SELECT p.steam_id, p.name, p.first_seen, p.last_seen,
              EXISTS (
                SELECT 1 FROM player_sessions s
                WHERE s.server_id = p.server_id AND s.steam_id = p.steam_id AND s.left_at IS NULL
              ) AS online
       FROM players p WHERE p.server_id = ?`,
    )
    .all(serverId);

  const sessions = db
    .prepare(
      `SELECT steam_id, joined_at, left_at, last_seen FROM player_sessions
       WHERE server_id = ? AND joined_at <= ? AND (left_at IS NULL OR left_at >= ?)`,
    )
    .all(serverId, now, since);

  const todayStart = startOfDay(now);
  const perPlayer = new Map();
  let totalMs = 0;
  let todayMs = 0;
  const activeToday = new Set();

  for (const session of sessions) {
    const start = Number(session.joined_at) || 0;
    const rawEnd = Number(session.left_at ?? session.last_seen ?? now) || start;
    const end = Math.min(Math.max(rawEnd, start), now);
    const duration = Math.max(0, end - start);
    totalMs += duration;
    const today = overlapMs(start, end, todayStart, now);
    todayMs += today;
    if (today > 0) activeToday.add(session.steam_id);

    const entry = perPlayer.get(session.steam_id) ?? { ms: 0, sessions: 0 };
    entry.ms += duration;
    entry.sessions += 1;
    perPlayer.set(session.steam_id, entry);
  }

  const nameOf = new Map(players.map((player) => [player.steam_id, player.name]));
  const ranking = [...perPlayer.entries()].map(([steamId, entry]) => ({
    steamId,
    name: nameOf.get(steamId) ?? steamId,
    ms: entry.ms,
    sessions: entry.sessions,
  }));

  const newPlayers = players.filter((player) => player.first_seen >= since);
  const returning = players.filter(
    (player) => player.first_seen < since && perPlayer.has(player.steam_id),
  );
  const inactive = inactivePlayers(serverId, inactiveRange, now);

  return {
    days: range,
    inactiveDays: inactiveRange,
    since,
    until: now,
    totals: {
      players: players.length,
      online: players.filter((player) => player.online).length,
      sessions: sessions.length,
      totalMs,
      todayMs,
      avgSessionMs: sessions.length ? Math.round(totalMs / sessions.length) : 0,
      activeToday: activeToday.size,
      newPlayers: newPlayers.length,
      returningPlayers: returning.length,
      inactivePlayers: inactive.length,
    },
    heatmap: heatmap(serverId, { days: range, now }),
    topByTime: ranking.sort((a, b) => b.ms - a.ms).slice(0, 10),
    topBySessions: [...ranking].sort((a, b) => b.sessions - a.sessions).slice(0, 10),
    retention: {
      newPlayers: newPlayers
        .sort((a, b) => b.first_seen - a.first_seen)
        .slice(0, 20)
        .map((player) => ({ steamId: player.steam_id, name: player.name, firstSeen: player.first_seen })),
      inactive: inactive.slice(0, 20),
    },
  };
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(header, rows) {
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function iso(ts) {
  return ts ? new Date(ts).toISOString() : '';
}

export function playersCsv(serverId) {
  const rows = getDb()
    .prepare(
      `SELECT p.steam_id, p.name, p.first_seen, p.last_seen, p.session_count, p.note,
              EXISTS (
                SELECT 1 FROM player_sessions s
                WHERE s.server_id = p.server_id AND s.steam_id = p.steam_id AND s.left_at IS NULL
              ) AS online
       FROM players p WHERE p.server_id = ? ORDER BY p.last_seen DESC LIMIT ?`,
    )
    .all(serverId, MAX_CSV_ROWS);
  return csv(
    ['steam_id', 'name', 'online', 'first_seen', 'last_seen', 'session_count', 'note'],
    rows.map((row) => [
      row.steam_id,
      row.name,
      row.online ? 'yes' : 'no',
      iso(row.first_seen),
      iso(row.last_seen),
      row.session_count,
      row.note ?? '',
    ]),
  );
}

export function sessionsCsv(serverId) {
  const rows = getDb()
    .prepare(
      `SELECT steam_id, name, joined_at, left_at, last_seen FROM player_sessions
       WHERE server_id = ? ORDER BY joined_at DESC LIMIT ?`,
    )
    .all(serverId, MAX_CSV_ROWS);
  const now = Date.now();
  return csv(
    ['steam_id', 'name', 'joined_at', 'left_at', 'duration_minutes'],
    rows.map((row) => [
      row.steam_id,
      row.name,
      iso(row.joined_at),
      iso(row.left_at),
      Math.round(sessionMs(row, now) / 60000),
    ]),
  );
}
