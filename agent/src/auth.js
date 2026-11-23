import crypto from 'node:crypto';
import { getDb } from './db.js';
import { ValidationError } from './store.js';
import {
  countUsers,
  createUser,
  findUserByUsername,
  getUser,
  migrateLegacyAuth,
  ownerUser,
  setUserPassword,
  setUserTotp,
  touchLogin,
  verifyUserPassword,
} from './users.js';
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
const EMPTY_TOTP = { enabled: false, secret: null, pendingSecret: null, recoveryCodes: [], enabledAt: null };

export function needsSetup() {
  migrateLegacyAuth();
  return countUsers() === 0;
}

/**
 * Compatibilidade com o fluxo antigo de setup: cria o primeiro proprietário
 * (ou troca a senha do proprietário existente).
 */
export function setPassword(password) {
  migrateLegacyAuth();
  const owner = ownerUser();
  if (!owner) {
    createUser({ username: 'owner', password, role: 'owner' });
  } else {
    setUserPassword(owner.id, password);
  }
  getDb().prepare('DELETE FROM sessions').run();
  getDb().prepare('DELETE FROM pending_2fa').run();
}

export function verifyPassword(password) {
  migrateLegacyAuth();
  const owner = ownerUser();
  return owner ? verifyUserPassword(owner, password) : false;
}

export function totpEnabled(userId = null) {
  const user = userId ? getUser(userId) : ownerUser();
  return Boolean(user?.totp?.enabled && user?.totp?.secret);
}

export function beginTotpSetup({ account = 'painel', userId = null } = {}) {
  const user = requireUser(userId);
  if (user.totp?.enabled) {
    throw new ValidationError('A verificação em duas etapas já está ativa.');
  }
  const secret = generateSecret();
  setUserTotp(user.id, { ...EMPTY_TOTP, pendingSecret: secret });
  return { secret, otpauth: otpauthUrl({ secret, account: `${account}:${user.username}` }) };
}

export function confirmTotpSetup(code, userId = null) {
  const user = requireUser(userId);
  if (user.totp?.enabled) throw new ValidationError('A verificação em duas etapas já está ativa.');
  if (!user.totp?.pendingSecret) throw new ValidationError('Inicie a configuração do 2FA antes de confirmar o código.');
  if (!verifyTotp(user.totp.pendingSecret, code)) {
    throw new ValidationError('Código inválido. Confira o horário do dispositivo e tente novamente.');
  }
  const recoveryCodes = generateRecoveryCodes();
  setUserTotp(user.id, {
    enabled: true,
    secret: user.totp.pendingSecret,
    pendingSecret: null,
    recoveryCodes: recoveryCodes.map(hashRecoveryCode),
    enabledAt: new Date().toISOString(),
  });
  return { recoveryCodes };
}

export function disableTotp({ password, code }, userId = null) {
  const user = requireUser(userId);
  if (!verifyUserPassword(user, password)) throw new ValidationError('Senha incorreta.');
  if (!verifySecondFactor(code, user.id).ok) throw new ValidationError('Código inválido.');
  setUserTotp(user.id, EMPTY_TOTP);
}

export function verifySecondFactor(code, userId = null) {
  const user = requireUser(userId);
  const totp = user.totp ?? EMPTY_TOTP;
  if (!totp.enabled || !totp.secret) return { ok: true, recovery: false };
  if (verifyTotp(totp.secret, code)) return { ok: true, recovery: false };
  const hash = hashRecoveryCode(code);
  const codes = Array.isArray(totp.recoveryCodes) ? totp.recoveryCodes : [];
  if (codes.includes(hash)) {
    setUserTotp(user.id, { ...totp, recoveryCodes: codes.filter((item) => item !== hash) });
    return { ok: true, recovery: true };
  }
  return { ok: false, recovery: false };
}

export function createPendingChallenge({ ip, userAgent, userId }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const db = getDb();
  db.prepare('DELETE FROM pending_2fa WHERE expires_at < ?').run(now);
  db.prepare(
    'INSERT INTO pending_2fa (token_hash, created_at, expires_at, ip, user_agent, user_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(sha256(token), now, now + CHALLENGE_TTL_MS, ip ?? null, String(userAgent ?? '').slice(0, 300), Number(userId));
  return { token, expiresAt: now + CHALLENGE_TTL_MS };
}

export function readPendingChallenge(token) {
  if (!token) return null;
  const row = getDb()
    .prepare('SELECT token_hash, expires_at, user_id FROM pending_2fa WHERE token_hash = ?')
    .get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    destroyPendingChallenge(token);
    return null;
  }
  return { expiresAt: row.expires_at, userId: Number(row.user_id) };
}

export function destroyPendingChallenge(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM pending_2fa WHERE token_hash = ?').run(sha256(token));
}

export function createSession({ ip, userAgent, userId = null }) {
  const user = requireUser(userId);
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = sha256(token);
  const now = Date.now();
  getDb()
    .prepare(
      'INSERT INTO sessions (token_hash, created_at, expires_at, ip, user_agent, user_id) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(hash, now, now + SESSION_TTL_MS, ip ?? null, String(userAgent ?? '').slice(0, 300), user.id);
  touchLogin(user.id);
  return { token, expiresAt: now + SESSION_TTL_MS, user: { id: user.id, username: user.username, role: user.role } };
}

export function readSession(token) {
  if (!token) return null;
  const row = getDb()
    .prepare(
      `SELECT s.token_hash, s.expires_at, s.user_id, u.username, u.role, u.disabled
       FROM sessions s LEFT JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now() || !row.user_id || row.disabled) {
    getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  return {
    expiresAt: row.expires_at,
    userId: Number(row.user_id),
    username: row.username,
    role: row.role,
  };
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

/** Restringe a rota aos papéis informados. */
export function requireRole(...roles) {
  const allowed = roles.flat();
  return (req, res, next) => {
    if (!req.session) {
      res.status(401).json({ error: 'Não autenticado.' });
      return;
    }
    if (!allowed.includes(req.session.role)) {
      res.status(403).json({ error: 'Seu papel não permite esta ação.', role: req.session.role });
      return;
    }
    next();
  };
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

function requireUser(userId) {
  migrateLegacyAuth();
  const user = userId ? getUser(userId) : ownerUser();
  if (!user) throw new ValidationError('Usuário não encontrado.');
  return user;
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

export { findUserByUsername };
