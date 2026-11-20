import { DatabaseSync } from 'node:sqlite';
import { dbFile, ensureDirs } from './paths.js';

let db = null;

export function getDb() {
  if (db) return db;
  ensureDirs();
  db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      action TEXT NOT NULL,
      server_id TEXT,
      detail TEXT,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit (ts DESC);
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      state TEXT NOT NULL,
      players INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_samples_server_ts ON samples (server_id, ts DESC);
  `);
  return db;
}

export function audit(action, { serverId = null, detail = null, ip = null } = {}) {
  try {
    getDb()
      .prepare('INSERT INTO audit (ts, action, server_id, detail, ip) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), action, serverId, detail ? String(detail).slice(0, 500) : null, ip);
  } catch (err) {
    console.error('[audit] falha ao gravar evento:', err.message);
  }
}

export function listAudit(limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return getDb()
    .prepare('SELECT id, ts, action, server_id AS serverId, detail, ip FROM audit ORDER BY id DESC LIMIT ?')
    .all(safeLimit);
}

export function recordSample(serverId, state, players) {
  try {
    getDb()
      .prepare('INSERT INTO samples (server_id, ts, state, players) VALUES (?, ?, ?, ?)')
      .run(serverId, Date.now(), state, players ?? null);
  } catch (err) {
    console.error('[samples] falha ao gravar amostra:', err.message);
  }
}

export function listSamples(serverId, limit = 120) {
  const safeLimit = Math.min(Math.max(Number(limit) || 120, 1), 1000);
  return getDb()
    .prepare('SELECT ts, state, players FROM samples WHERE server_id = ? ORDER BY id DESC LIMIT ?')
    .all(serverId, safeLimit)
    .reverse();
}

export function pruneSamples(olderThanMs = 7 * 24 * 60 * 60 * 1000) {
  try {
    getDb().prepare('DELETE FROM samples WHERE ts < ?').run(Date.now() - olderThanMs);
  } catch (err) {
    console.error('[samples] falha ao limpar amostras:', err.message);
  }
}
