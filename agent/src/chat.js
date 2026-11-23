import { getDb } from './db.js';

/**
 * Extrai a mensagem estruturada do evento de chat do RCON.
 * O Rust envia `Message` como JSON em string (ou já como objeto, em plugins).
 */
export function parseChatMessage(message) {
  const raw = message?.Message;
  let payload = null;

  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text.startsWith('{')) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!payload) {
      return text ? { steamId: null, username: null, text, channel: null } : null;
    }
  } else if (raw && typeof raw === 'object') {
    payload = raw;
  } else {
    return null;
  }

  const text = String(payload.Message ?? '').trim();
  if (!text) return null;
  const steamId = String(payload.UserId ?? payload.SteamID ?? '').trim();
  const channel = Number(payload.Channel);

  return {
    steamId: /^\d{17}$/.test(steamId) ? steamId : null,
    username: String(payload.Username ?? '').trim() || null,
    text,
    channel: Number.isFinite(channel) ? channel : null,
  };
}

/** Primeira palavra-chave que casa com o texto, sem diferenciar maiúsculas. */
export function matchChatRule(text, keywords) {
  const haystack = String(text ?? '').toLowerCase();
  if (!haystack) return null;
  for (const keyword of Array.isArray(keywords) ? keywords : []) {
    const needle = String(keyword ?? '').trim().toLowerCase();
    if (needle && haystack.includes(needle)) return String(keyword).trim();
  }
  return null;
}

export function recordChat({ serverId, steamId = null, username = null, text, channel = null, filter = null, ts = Date.now() }) {
  const db = getDb();
  const body = String(text ?? '').trim();
  if (!body) return null;
  const rule = filter?.enabled ? matchChatRule(body, filter.keywords) : null;
  const flagged = rule ? 1 : 0;
  const result = db
    .prepare(
      `INSERT INTO chat_messages (ts, server_id, steam_id, username, message, channel, flagged, rule)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ts, serverId, steamId, username, body, channel, flagged, rule);
  return {
    id: Number(result.lastInsertRowid),
    ts,
    serverId,
    steamId,
    username,
    message: body,
    channel,
    flagged: Boolean(flagged),
    rule,
  };
}

export function listChat(serverId, { limit = 200, flagged = false } = {}) {
  const db = getDb();
  const max = Math.min(Math.max(Number.parseInt(limit, 10) || 200, 1), 1000);
  const rows = flagged
    ? db
        .prepare(
          'SELECT * FROM chat_messages WHERE server_id = ? AND flagged = 1 ORDER BY ts DESC LIMIT ?',
        )
        .all(serverId, max)
    : db.prepare('SELECT * FROM chat_messages WHERE server_id = ? ORDER BY ts DESC LIMIT ?').all(serverId, max);
  return rows
    .map((row) => ({
      id: row.id,
      ts: row.ts,
      serverId: row.server_id,
      steamId: row.steam_id,
      username: row.username,
      message: row.message,
      channel: row.channel,
      flagged: Boolean(row.flagged),
      rule: row.rule,
    }))
    .reverse();
}
