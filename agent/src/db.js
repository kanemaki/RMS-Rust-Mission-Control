import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { dbFile, ensureDirs } from './paths.js';
import { ValidationError } from './errors.js';

let db = null;

/** Quem está executando a requisição atual, para preencher audit.actor. */
export const auditContext = new AsyncLocalStorage();

export function getDb() {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT,
      user_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      disabled INTEGER NOT NULL DEFAULT 0,
      totp TEXT,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      action TEXT NOT NULL,
      server_id TEXT,
      detail TEXT,
      ip TEXT,
      actor TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit (ts DESC);
    CREATE TABLE IF NOT EXISTS pending_2fa (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT,
      user_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      state TEXT NOT NULL,
      players INTEGER,
      cpu REAL,
      mem INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_samples_server_ts ON samples (server_id, ts DESC);
    CREATE TABLE IF NOT EXISTS license_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS players (
      server_id TEXT NOT NULL,
      steam_id TEXT NOT NULL,
      name TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      last_session_at INTEGER,
      session_count INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      PRIMARY KEY (server_id, steam_id)
    );
    CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players (server_id, last_seen DESC);
    CREATE TABLE IF NOT EXISTS player_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      steam_id TEXT NOT NULL,
      name TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      left_at INTEGER,
      last_seen INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_player ON player_sessions (server_id, steam_id, joined_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_open ON player_sessions (server_id, steam_id, left_at);
    CREATE TABLE IF NOT EXISTS moderation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      server_id TEXT NOT NULL,
      steam_id TEXT NOT NULL,
      name TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      minutes INTEGER,
      expires_at INTEGER,
      resolved_at INTEGER,
      actor TEXT,
      synced TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_moderation_player ON moderation (server_id, steam_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_moderation_expires ON moderation (server_id, expires_at);
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      server_id TEXT NOT NULL,
      steam_id TEXT,
      username TEXT,
      message TEXT NOT NULL,
      channel INTEGER,
      flagged INTEGER NOT NULL DEFAULT 0,
      rule TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_server_ts ON chat_messages (server_id, ts DESC);
  `);
  migrateSamples(db);
  migrateModeration(db);
  migrateAuth(db);
  return db;
}

function migrateAuth(db) {
  const sessionColumns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name));
  if (!sessionColumns.has('user_id')) db.exec('ALTER TABLE sessions ADD COLUMN user_id INTEGER;');
  const pendingColumns = new Set(db.prepare('PRAGMA table_info(pending_2fa)').all().map((column) => column.name));
  if (!pendingColumns.has('user_id')) db.exec('ALTER TABLE pending_2fa ADD COLUMN user_id INTEGER;');
  const auditColumns = new Set(db.prepare('PRAGMA table_info(audit)').all().map((column) => column.name));
  if (!auditColumns.has('actor')) db.exec('ALTER TABLE audit ADD COLUMN actor TEXT;');
}

function migrateModeration(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(moderation)').all().map((column) => column.name));
  if (!columns.has('resolved_at')) db.exec('ALTER TABLE moderation ADD COLUMN resolved_at INTEGER;');
  if (!columns.has('synced')) db.exec('ALTER TABLE moderation ADD COLUMN synced TEXT;');
}

function migrateSamples(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(samples)').all().map((column) => column.name));
  if (!columns.has('cpu')) db.exec('ALTER TABLE samples ADD COLUMN cpu REAL;');
  if (!columns.has('mem')) db.exec('ALTER TABLE samples ADD COLUMN mem INTEGER;');
}

export function closeDb() {
  if (!db) return;
  try {
    db.close();
  } finally {
    db = null;
  }
}

export function audit(action, { serverId = null, detail = null, ip = null, actor = null } = {}) {
  try {
    const who = actor ?? auditContext.getStore()?.actor ?? null;
    getDb()
      .prepare('INSERT INTO audit (ts, action, server_id, detail, ip, actor) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Date.now(), action, serverId, detail ? String(detail).slice(0, 500) : null, ip, who);
  } catch (err) {
    console.error('[audit] falha ao gravar evento:', err.message);
  }
}

export function listAudit(limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return getDb()
    .prepare('SELECT id, ts, action, server_id AS serverId, detail, ip, actor FROM audit ORDER BY id DESC LIMIT ?')
    .all(safeLimit);
}

export function recordSample(serverId, state, players, cpu = null, mem = null) {
  try {
    getDb()
      .prepare('INSERT INTO samples (server_id, ts, state, players, cpu, mem) VALUES (?, ?, ?, ?, ?, ?)')
      .run(serverId, Date.now(), state, players ?? null, cpu ?? null, mem ?? null);
  } catch (err) {
    console.error('[samples] falha ao gravar amostra:', err.message);
  }
}

export function listSamples(serverId, limit = 120) {
  const safeLimit = Math.min(Math.max(Number(limit) || 120, 1), 1000);
  return getDb()
    .prepare('SELECT ts, state, players, cpu, mem FROM samples WHERE server_id = ? ORDER BY id DESC LIMIT ?')
    .all(serverId, safeLimit)
    .reverse();
}

export function listSamplesRange(serverId, { since, until = Date.now(), bucketMs }) {
  const sinceMs = Math.max(0, Number(since) || 0);
  const untilMs = Number(until) || Date.now();
  if (!bucketMs || bucketMs < 60_000) throw new ValidationError('Intervalo de agregação inválido.');
  const rows = getDb()
    .prepare(
      `SELECT
        (ts / CAST(:bucket AS INTEGER)) * CAST(:bucket AS INTEGER) AS bucket,
        COALESCE(AVG(players), 0) AS players,
        AVG(mem) AS mem,
        MAX(cpu) AS cpu,
        CASE
          WHEN SUM(state = 'running') > 0 THEN 'running'
          WHEN SUM(state = 'updating') > 0 THEN 'updating'
          WHEN SUM(state = 'starting') > 0 THEN 'starting'
          WHEN SUM(state = 'stopping') > 0 THEN 'stopping'
          WHEN SUM(state = 'error') > 0 THEN 'error'
          ELSE 'stopped'
        END AS state,
        COUNT(*) AS samples
      FROM samples
      WHERE server_id = :id AND ts >= :since AND ts <= :until
      GROUP BY bucket
      ORDER BY bucket ASC`,
    )
    .all({ id: serverId, bucket: Math.floor(bucketMs), since: sinceMs, until: untilMs });
  return rows.map((row) => ({
    ts: row.bucket,
    state: row.state,
    players: Math.round(row.players * 100) / 100,
    cpu: row.cpu ?? null,
    mem: row.mem === null ? null : Math.round(row.mem),
    samples: row.samples,
  }));
}

export function pruneSamples(olderThanMs = 30 * 24 * 60 * 60 * 1000) {
  try {
    getDb().prepare('DELETE FROM samples WHERE ts < ?').run(Date.now() - olderThanMs);
  } catch (err) {
    console.error('[samples] falha ao limpar amostras:', err.message);
  }
}

export function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM license_meta WHERE key = ?').get(String(key));
  return row?.value ?? null;
}

export function setMeta(key, value) {
  getDb()
    .prepare('INSERT INTO license_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(String(key), String(value));
}
