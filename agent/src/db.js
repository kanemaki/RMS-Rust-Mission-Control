import { DatabaseSync } from 'node:sqlite';
import { dbFile, ensureDirs } from './paths.js';
import { ValidationError } from './errors.js';

let db = null;

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
    CREATE TABLE IF NOT EXISTS pending_2fa (
      token_hash TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT
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
  `);
  migrateSamples(db);
  return db;
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
