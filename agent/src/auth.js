import crypto from 'node:crypto';
import { getDb } from './db.js';
import { loadConfig, saveConfig, ValidationError } from './store.js';
import {
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from './totp.js';

const COOKIE = 'rmc_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
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
  config.auth = {
    passwordHash: hash,
    salt,
    createdAt: new Date().toISOString(),
    totp: config.auth?.totp ?? { enabled: false, secret: null, pendingSecret: null, recoveryCodes: [], enabledAt: null },
  };
  saveConfig(config);
  getDb().prepare('DELETE FROM sessions').run();
  getDb().prepare('DELETE FROM pending_2fa').run();
}

export function verifyPassword(password) {
  const { auth } = loadConfig();
  if (!auth.passwordHash || !auth.salt) return false;
  const expected = Buffer.from(auth.passwordHash, 'hex');
  const actual = crypto.scryptSync(String(password ?? ''), auth.salt, SCRYPT_KEYLEN);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function totpEnabled() {
  const { totp } = loadConfig().auth;
  return Boolean(totp?.enabled && totp?.secret);
}

export function beginTotpSetup({ account = 'painel' } = {}) {
  const config = loadConfig();
  if (config.auth.totp?.enabled) {
    throw new ValidationError('A verificação em duas etapas já está ativa.');
  }
  const secret = generateSecret();
  config.auth.totp = {
    enabled: false,
    secret: null,
    pendingSecret: secret,
    recoveryCodes: [],
    enabledAt: null,
  };
  saveConfig(config);
  return { secret, otpauth: otpauthUrl({ secret, account }) };
}

export function confirmTotpSetup(code) {
  const config = loadConfig();
  const totp = config.auth.totp ?? {};
  if (totp.enabled) throw new ValidationError('A verificação em duas etapas já está ativa.');
  if (!totp.pendingSecret) throw new ValidationError('Inicie a configuração do 2FA antes de confirmar o código.');
  if (!verifyTotp(totp.pendingSecret, code)) {
    throw new ValidationError('Código inválido. Confira o horário do dispositivo e tente novamente.');
  }
  const recoveryCodes = generateRecoveryCodes();
  config.auth.totp = {
    enabled: true,
    secret: totp.pendingSecret,
    pendingSecret: null,
    recoveryCodes: recoveryCodes.map(hashRecoveryCode),
    enabledAt: new Date().toISOString(),
  };
  saveConfig(config);
  return { recoveryCodes };
}

export function disableTotp({ password, code }) {
  if (!verifyPassword(password)) throw new ValidationError('Senha incorreta.');
  if (!verifySecondFactor(code).ok) throw new ValidationError('Código inválido.');
  const config = loadConfig();
  config.auth.totp = { enabled: false, secret: null, pendingSecret: null, recoveryCodes: [], enabledAt: null };
  saveConfig(config);
}

export function verifySecondFactor(code) {
  const totp = loadConfig().auth.totp ?? {};
  if (!totp.enabled || !totp.secret) return { ok: true, recovery: false };
  if (verifyTotp(totp.secret, code)) return { ok: true, recovery: false };
  const hash = hashRecoveryCode(code);
  const codes = Array.isArray(totp.recoveryCodes) ? totp.recoveryCodes : [];
  if (codes.includes(hash)) {
    const config = loadConfig();
    config.auth.totp.recoveryCodes = codes.filter((item) => item !== hash);
    saveConfig(config);
    return { ok: true, recovery: true };
  }
  return { ok: false, recovery: false };
}

export function createPendingChallenge({ ip, userAgent }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const db = getDb();
  db.prepare('DELETE FROM pending_2fa WHERE expires_at < ?').run(now);
  db.prepare(
    'INSERT INTO pending_2fa (token_hash, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
  ).run(sha256(token), now, now + CHALLENGE_TTL_MS, ip ?? null, String(userAgent ?? '').slice(0, 300));
  return { token, expiresAt: now + CHALLENGE_TTL_MS };
}

export function readPendingChallenge(token) {
  if (!token) return null;
  const row = getDb()
    .prepare('SELECT token_hash, expires_at FROM pending_2fa WHERE token_hash = ?')
    .get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroyPendingChallenge(token);
    return null;
  }
  return { expiresAt: row.expires_at };
}

export function destroyPendingChallenge(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM pending_2fa WHERE token_hash = ?').run(sha256(token));
}

export function createSession({ ip, userAgent }) {  const token = crypto.randomBytes(32).toString('base64url');
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

const totpAttempts = new Map();

export function totpRateLimit(req, res, next) {
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const entry = totpAttempts.get(key) ?? { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 15 * 60 * 1000;
  }
  if (entry.count >= 10) {
    res.status(429).json({ error: 'Muitas tentativas de código. Tente novamente em alguns minutos.' });
    return;
  }
  entry.count += 1;
  totpAttempts.set(key, entry);
  next();
}

export function resetTotpAttempts(ip) {
  totpAttempts.delete(ip);
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
