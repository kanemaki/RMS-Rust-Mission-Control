import crypto from 'node:crypto';
import { getDb } from './db.js';
import { loadConfig, saveConfig, ValidationError } from './store.js';

const COOKIE = 'rmc_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT_KEYLEN = 64;

export function needsSetup() {
  return !loadConfig().auth.passwordHash;
}

export function setPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new ValidationError('A senha precisa ter ao menos 10 caracteres.');
  }
  if (password.length > 200) throw new ValidationError('Senha muito longa.');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  const config = loadConfig();
  config.auth = { passwordHash: hash, salt, createdAt: new Date().toISOString() };
  saveConfig(config);
  getDb().prepare('DELETE FROM sessions').run();
}

export function verifyPassword(password) {
  const { auth } = loadConfig();
  if (!auth.passwordHash || !auth.salt) return false;
  const expected = Buffer.from(auth.passwordHash, 'hex');
  const actual = crypto.scryptSync(String(password ?? ''), auth.salt, SCRYPT_KEYLEN);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function createSession({ ip, userAgent }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = sha256(token);
  const now = Date.now();
  getDb()
    .prepare('INSERT INTO sessions (token_hash, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)')
    .run(hash, now, now + SESSION_TTL_MS, ip ?? null, String(userAgent ?? '').slice(0, 300));
  return { token, expiresAt: now + SESSION_TTL_MS };
}

export function readSession(token) {
  if (!token) return null;
  const row = getDb()
    .prepare('SELECT token_hash, expires_at FROM sessions WHERE token_hash = ?')
    .get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  return { expiresAt: row.expires_at };
}

export function destroySession(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function sessionCookie(token, { secure = false } = {}) {
  const parts = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function tokenFromRequest(req) {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return parseCookies(req.headers.cookie ?? '')[COOKIE] ?? null;
}

export function requireAuth(req, res, next) {
  const session = readSession(tokenFromRequest(req));
  if (!session) {
    res.status(401).json({ error: 'Não autenticado.' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('x-rmc-request') !== '1') {
    res.status(403).json({ error: 'Cabeçalho x-rmc-request ausente.' });
    return;
  }
  req.session = session;
  next();
}

export function requireSetupDone(req, res, next) {
  if (needsSetup()) {
    res.status(409).json({ error: 'Configure a senha do painel primeiro.', needsSetup: true });
    return;
  }
  next();
}

const attempts = new Map();

export function loginRateLimit(req, res, next) {
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const entry = attempts.get(key) ?? { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 15 * 60 * 1000;
  }
  if (entry.count >= 8) {
    res.status(429).json({ error: 'Muitas tentativas. Tente novamente em alguns minutos.' });
    return;
  }
  entry.count += 1;
  attempts.set(key, entry);
  next();
}

export function resetLoginAttempts(ip) {
  attempts.delete(ip);
}

function parseCookies(header) {
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
