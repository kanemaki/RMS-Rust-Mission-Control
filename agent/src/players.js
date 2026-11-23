import { getDb } from './db.js';
import { ValidationError } from './errors.js';

const STEAM_RE = /^\d{17}$/;
const ACTIONS = new Set(['kick', 'ban', 'unban', 'mute', 'unmute', 'owner', 'unowner']);
const MAX_REASON = 300;
const MAX_NOTE = 2000;

export function normalizeSteamId(value) {
  const steamId = String(value ?? '').trim();
  if (!STEAM_RE.test(steamId)) throw new ValidationError('SteamID inválido.');
  return steamId;
}

export function normalizeAction(value) {
  const action = String(value ?? '').trim().toLowerCase();
  if (!ACTIONS.has(action)) {
    throw new ValidationError('Ação inválida: use kick, ban, unban, mute, unmute, owner ou unowner.');
  }
  return action;
}

export function normalizeReason(value) {
  return String(value ?? '').trim().slice(0, MAX_REASON);
}

export function normalizeMinutes(value) {
  if (value === null || value === undefined || value === '') return null;
  const minutes = Number.parseInt(value, 10);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 525600) {
    throw new ValidationError('A duração do ban deve ser entre 1 minuto e 1 ano (525600 minutos).');
  }
  return minutes;
}

/**
 * Compara a lista atual do `playerlist` com as sessões abertas e mantém o
 * histórico de entradas/saídas. Jogadores sem SteamID são ignorados aqui, mas
 * continuam contando no total exibido pelo runtime.
 */
export function trackPlayers(serverId, list, now = Date.now()) {
  const db = getDb();
  const incoming = new Map();
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry?.steamId || !STEAM_RE.test(entry.steamId)) continue;
    incoming.set(entry.steamId, entry);
  }

  const open = db
    .prepare('SELECT id, steam_id FROM player_sessions WHERE server_id = ? AND left_at IS NULL')
    .all(serverId);
  const openIds = new Set(open.map((session) => session.steam_id));

  const closeSession = db.prepare('UPDATE player_sessions SET left_at = ? WHERE id = ?');
  for (const session of open) {
    if (!incoming.has(session.steam_id)) closeSession.run(now, session.id);
  }

  const findPlayer = db.prepare('SELECT steam_id FROM players WHERE server_id = ? AND steam_id = ?');
  const insertPlayer = db.prepare(
    `INSERT INTO players (server_id, steam_id, name, first_seen, last_seen, last_session_at, session_count, note)
     VALUES (?, ?, ?, ?, ?, NULL, 0, NULL)`,
  );
  const touchPlayer = db.prepare('UPDATE players SET name = ?, last_seen = ? WHERE server_id = ? AND steam_id = ?');
  const openSession = db.prepare(
    `INSERT INTO player_sessions (server_id, steam_id, name, joined_at, left_at, last_seen)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  );
  const touchSession = db.prepare(
    'UPDATE player_sessions SET last_seen = ?, name = ? WHERE server_id = ? AND steam_id = ? AND left_at IS NULL',
  );
  const bumpSession = db.prepare(
    'UPDATE players SET session_count = session_count + 1, last_session_at = ? WHERE server_id = ? AND steam_id = ?',
  );

  for (const [steamId, entry] of incoming) {
    const name = String(entry.name ?? '').trim() || steamId;
    if (findPlayer.get(serverId, steamId)) {
      touchPlayer.run(name, now, serverId, steamId);
    } else {
      insertPlayer.run(serverId, steamId, name, now, now);
    }
    if (openIds.has(steamId)) {
      touchSession.run(now, name, serverId, steamId);
    } else {
      openSession.run(serverId, steamId, name, now, now);
      bumpSession.run(now, serverId, steamId);
    }
  }

  return { online: incoming.size };
}

/**
 * Fecha todas as sessões abertas de um servidor. Usado quando o servidor para
 * ou o processo morre: sem o `playerlist` não há como saber quem saiu, e deixar
 * as sessões abertas faria todos aparecerem online para sempre.
 */
export function closeSessions(serverId, now = Date.now()) {
  const db = getDb();
  const result = db
    .prepare('UPDATE player_sessions SET left_at = ? WHERE server_id = ? AND left_at IS NULL')
    .run(now, serverId);
  return { closed: result.changes };
}

/**
 * Fecha as sessões abertas de todos os servidores. Usado no boot do agente:
 * nenhum runtime está rodando ainda, então qualquer sessão aberta no banco é
 * resíduo de uma execução anterior.
 */
export function closeAllSessions(now = Date.now()) {
  const db = getDb();
  const result = db.prepare('UPDATE player_sessions SET left_at = ? WHERE left_at IS NULL').run(now);
  return { closed: result.changes };
}

export function listPlayers(serverId, { search = '', limit = 100 } = {}) {
  const db = getDb();
  const term = String(search ?? '').trim().toLowerCase();
  const max = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  const like = `%${term}%`;

  const rows = db
    .prepare(
      `SELECT p.*,
              EXISTS (
                SELECT 1 FROM player_sessions s
                WHERE s.server_id = p.server_id AND s.steam_id = p.steam_id AND s.left_at IS NULL
              ) AS online,
              (SELECT MAX(s.joined_at) FROM player_sessions s
               WHERE s.server_id = p.server_id AND s.steam_id = p.steam_id AND s.left_at IS NULL) AS online_since
       FROM players p
       WHERE p.server_id = ?
         AND (? = '' OR LOWER(p.name) LIKE ? OR p.steam_id LIKE ?)
       ORDER BY online DESC, p.last_seen DESC
       LIMIT ?`,
    )
    .all(serverId, term, like, like, max);

  const states = latestStates(serverId);
  const items = rows.map((row) => toPlayer(row, states.get(row.steam_id)));
  return {
    online: items.filter((item) => item.online),
    recent: items.filter((item) => !item.online),
    total: items.length,
  };
}

export function getPlayer(serverId, steamId) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT p.*,
              EXISTS (
                SELECT 1 FROM player_sessions s
                WHERE s.server_id = p.server_id AND s.steam_id = p.steam_id AND s.left_at IS NULL
              ) AS online,
              (SELECT MAX(s.joined_at) FROM player_sessions s
               WHERE s.server_id = p.server_id AND s.steam_id = p.steam_id AND s.left_at IS NULL) AS online_since
       FROM players p WHERE p.server_id = ? AND p.steam_id = ?`,
    )
    .get(serverId, steamId);
  if (!row) return null;

  const sessions = db
    .prepare(
      `SELECT id, joined_at, left_at, last_seen, name FROM player_sessions
       WHERE server_id = ? AND steam_id = ? ORDER BY joined_at DESC LIMIT 50`,
    )
    .all(serverId, steamId);
  const moderation = listModeration(serverId, { steamId, limit: 100 });
  const chatCount = db
    .prepare('SELECT COUNT(*) AS total FROM chat_messages WHERE server_id = ? AND steam_id = ?')
    .get(serverId, steamId).total;

  return {
    ...toPlayer(row, latestStates(serverId).get(steamId)),
    sessions,
    moderation,
    chatCount,
  };
}

export function setPlayerNote(serverId, steamId, note) {
  const db = getDb();
  const text = String(note ?? '').trim().slice(0, MAX_NOTE);
  const existing = db
    .prepare('SELECT steam_id FROM players WHERE server_id = ? AND steam_id = ?')
    .get(serverId, steamId);
  if (!existing) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO players (server_id, steam_id, name, first_seen, last_seen, last_session_at, session_count, note)
       VALUES (?, ?, ?, ?, ?, NULL, 0, ?)`,
    ).run(serverId, steamId, steamId, now, now, text);
  } else {
    db.prepare('UPDATE players SET note = ? WHERE server_id = ? AND steam_id = ?').run(text, serverId, steamId);
  }
  return { steamId, note: text };
}

export function recordModeration({
  serverId,
  steamId,
  name,
  action,
  reason = '',
  minutes = null,
  expiresAt = null,
  actor = 'panel',
  synced = null,
  ts = Date.now(),
}) {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO moderation (ts, server_id, steam_id, name, action, reason, minutes, expires_at, resolved_at, actor, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      ts,
      serverId,
      steamId,
      String(name ?? '').trim() || steamId,
      action,
      reason || null,
      minutes,
      expiresAt,
      actor,
      synced ? JSON.stringify(synced) : null,
    );
  return toModeration(db.prepare('SELECT * FROM moderation WHERE id = ?').get(result.lastInsertRowid));
}

export function listModeration(serverId, { steamId = null, limit = 100 } = {}) {
  const db = getDb();
  const max = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  const rows = steamId
    ? db
        .prepare('SELECT * FROM moderation WHERE server_id = ? AND steam_id = ? ORDER BY ts DESC LIMIT ?')
        .all(serverId, steamId, max)
    : db.prepare('SELECT * FROM moderation WHERE server_id = ? ORDER BY ts DESC LIMIT ?').all(serverId, max);
  return rows.map(toModeration);
}

export function dueBans(serverId, now = Date.now()) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM moderation
       WHERE server_id = ? AND action = 'ban' AND expires_at IS NOT NULL
         AND resolved_at IS NULL AND expires_at <= ?
       ORDER BY expires_at ASC`,
    )
    .all(serverId, now)
    .map(toModeration);
}

export function resolveBans(serverId, steamId, now = Date.now()) {
  const db = getDb();
  db.prepare(
    `UPDATE moderation SET resolved_at = ?
     WHERE server_id = ? AND steam_id = ? AND action = 'ban' AND resolved_at IS NULL`,
  ).run(now, serverId, steamId);
}

/** Último mute/unmute, ban/unban e owner/unowner por jogador, para o painel mostrar o estado atual. */
export function latestStates(serverId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT m.* FROM moderation m
       JOIN (SELECT steam_id, MAX(id) AS id FROM moderation WHERE server_id = ? GROUP BY steam_id) last
         ON last.id = m.id`,
    )
    .all(serverId);
  const map = new Map();
  for (const row of rows) {
    map.set(row.steam_id, {
      lastAction: row.action,
      lastActionAt: row.ts,
      muted: row.action === 'mute',
      banned: row.action === 'ban' && (row.expires_at === null || row.expires_at > Date.now()),
      banExpiresAt: row.action === 'ban' ? row.expires_at : null,
      owner: false,
      ownerSince: null,
    });
  }

  // O estado de super usuário é independente do último mute/ban, então precisa
  // da última linha apenas entre owner/unowner.
  const ownerRows = db
    .prepare(
      `SELECT m.steam_id, m.action, m.ts FROM moderation m
       JOIN (SELECT steam_id, MAX(id) AS id FROM moderation
             WHERE server_id = ? AND action IN ('owner', 'unowner') GROUP BY steam_id) last
         ON last.id = m.id`,
    )
    .all(serverId);
  for (const row of ownerRows) {
    const state = map.get(row.steam_id) ?? {
      lastAction: null,
      lastActionAt: null,
      muted: false,
      banned: false,
      banExpiresAt: null,
    };
    state.owner = row.action === 'owner';
    state.ownerSince = row.action === 'owner' ? row.ts : null;
    map.set(row.steam_id, state);
  }
  return map;
}

function toPlayer(row, state) {
  return {
    steamId: row.steam_id,
    name: row.name,
    online: Boolean(row.online),
    onlineSince: row.online_since ?? null,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    lastSessionAt: row.last_session_at,
    sessionCount: row.session_count,
    note: row.note ?? '',
    muted: Boolean(state?.muted),
    banned: Boolean(state?.banned),
    banExpiresAt: state?.banExpiresAt ?? null,
    owner: Boolean(state?.owner),
    ownerSince: state?.ownerSince ?? null,
    lastAction: state?.lastAction ?? null,
    lastActionAt: state?.lastActionAt ?? null,
  };
}

function toModeration(row) {
  return {
    id: row.id,
    ts: row.ts,
    serverId: row.server_id,
    steamId: row.steam_id,
    name: row.name,
    action: row.action,
    reason: row.reason ?? '',
    minutes: row.minutes,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    actor: row.actor,
    synced: row.synced ? safeJson(row.synced) : null,
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
