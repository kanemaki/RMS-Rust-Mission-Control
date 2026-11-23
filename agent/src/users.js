import crypto from 'node:crypto';
import { getDb } from './db.js';
import { loadConfig } from './store.js';
import { ValidationError } from './errors.js';

export const ROLES = ['owner', 'admin', 'viewer'];
export const ROLE_LABELS = { owner: 'Proprietário', admin: 'Administrador', viewer: 'Somente leitura' };

const SCRYPT_KEYLEN = 64;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const EMPTY_TOTP = { enabled: false, secret: null, pendingSecret: null, recoveryCodes: [], enabledAt: null };

export function normalizeRole(role) {
  const value = String(role ?? '').trim().toLowerCase();
  if (!ROLES.includes(value)) throw new ValidationError('Papel inválido. Use owner, admin ou viewer.');
  return value;
}

export function normalizeUsername(username) {
  const value = String(username ?? '').trim();
  if (!USERNAME_RE.test(value)) {
    throw new ValidationError('O usuário deve ter de 3 a 32 caracteres: letras, números, ponto, hífen ou sublinhado.');
  }
  return value;
}

export function assertPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new ValidationError('A senha precisa ter ao menos 10 caracteres.');
  }
  if (password.length > 200) throw new ValidationError('Senha muito longa.');
  return password;
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(assertPassword(password), salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

export function verifyUserPassword(user, password) {
  if (!user?.passwordHash || !user?.salt) return false;
  const expected = Buffer.from(user.passwordHash, 'hex');
  const actual = crypto.scryptSync(String(password ?? ''), user.salt, SCRYPT_KEYLEN);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function countUsers() {
  return Number(getDb().prepare('SELECT COUNT(*) AS total FROM users').get().total);
}

export function countOwners() {
  return Number(
    getDb().prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'owner' AND disabled = 0").get().total,
  );
}

export function listUsers() {
  return getDb()
    .prepare('SELECT * FROM users ORDER BY id ASC')
    .all()
    .map(toPublicUser);
}

export function getUser(id) {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  return row ? toPublicUser(row) : null;
}

export function findUserByUsername(username) {
  const key = String(username ?? '').trim().toLowerCase();
  if (!key) return null;
  const row = getDb().prepare('SELECT * FROM users WHERE username_key = ?').get(key);
  return row ? toPublicUser(row) : null;
}

export function createUser({ username, password, role = 'viewer' }) {
  const name = normalizeUsername(username);
  const normalizedRole = normalizeRole(role);
  const { hash, salt } = hashPassword(password);
  const key = name.toLowerCase();
  if (findUserByUsername(key)) throw new ValidationError('Já existe um usuário com esse nome.');
  const now = Date.now();
  const info = getDb()
    .prepare(
      `INSERT INTO users (username, username_key, password_hash, salt, role, disabled, totp, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(name, key, hash, salt, normalizedRole, JSON.stringify(EMPTY_TOTP), now);
  return getUser(Number(info.lastInsertRowid));
}

export function updateUser(id, { role, disabled } = {}) {
  const user = getUser(id);
  if (!user) throw new ValidationError('Usuário não encontrado.');
  const nextRole = role === undefined ? user.role : normalizeRole(role);
  const nextDisabled = disabled === undefined ? user.disabled : Boolean(disabled);

  if (user.role === 'owner' && (nextRole !== 'owner' || nextDisabled)) {
    assertNotLastOwner(user.id);
  }
  getDb()
    .prepare('UPDATE users SET role = ?, disabled = ? WHERE id = ?')
    .run(nextRole, nextDisabled ? 1 : 0, user.id);
  if (nextDisabled) destroyUserSessions(user.id);
  return getUser(user.id);
}

export function setUserPassword(id, password) {
  const user = getUser(id);
  if (!user) throw new ValidationError('Usuário não encontrado.');
  const { hash, salt } = hashPassword(password);
  getDb().prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, user.id);
  destroyUserSessions(user.id);
  return getUser(user.id);
}

export function deleteUser(id) {
  const user = getUser(id);
  if (!user) throw new ValidationError('Usuário não encontrado.');
  if (user.role === 'owner') assertNotLastOwner(user.id);
  destroyUserSessions(user.id);
  getDb().prepare('DELETE FROM users WHERE id = ?').run(user.id);
  return { ok: true };
}

export function setUserTotp(id, totp) {
  const user = getUser(id);
  if (!user) throw new ValidationError('Usuário não encontrado.');
  getDb().prepare('UPDATE users SET totp = ? WHERE id = ?').run(JSON.stringify({ ...EMPTY_TOTP, ...totp }), user.id);
  return getUser(user.id);
}

export function resetUserTotp(id) {
  return setUserTotp(id, EMPTY_TOTP);
}

export function touchLogin(id) {
  getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), Number(id));
}

export function destroyUserSessions(userId) {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(userId));
}

export function ownerUser() {
  return findUserByUsername('owner') ?? listUsers().find((user) => user.role === 'owner') ?? null;
}

/**
 * Migra a credencial única antiga (config.auth) para a tabela users.
 * Idempotente: só age quando ainda não existe nenhum usuário.
 */
export function migrateLegacyAuth() {
  if (countUsers() > 0) return null;
  const { auth } = loadConfig();
  if (!auth?.passwordHash || !auth?.salt) return null;
  const now = Date.now();
  const totp = { ...EMPTY_TOTP, ...(auth.totp ?? {}) };
  const info = getDb()
    .prepare(
      `INSERT INTO users (username, username_key, password_hash, salt, role, disabled, totp, created_at)
       VALUES (?, ?, ?, ?, 'owner', 0, ?, ?)`,
    )
    .run('owner', 'owner', auth.passwordHash, auth.salt, JSON.stringify(totp), now);
  return getUser(Number(info.lastInsertRowid));
}

function assertNotLastOwner(id) {
  const row = getDb().prepare('SELECT role, disabled FROM users WHERE id = ?').get(Number(id));
  if (!row || row.role !== 'owner' || row.disabled) return;
  if (countOwners() <= 1) {
    throw new ValidationError('O painel precisa de ao menos um proprietário ativo.');
  }
}

function toPublicUser(row) {
  let totp = EMPTY_TOTP;
  try {
    totp = { ...EMPTY_TOTP, ...(row.totp ? JSON.parse(row.totp) : {}) };
  } catch {
    totp = EMPTY_TOTP;
  }
  return {
    id: Number(row.id),
    username: row.username,
    role: row.role,
    disabled: Boolean(row.disabled),
    totp,
    totpEnabled: Boolean(totp.enabled && totp.secret),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at ?? null,
    passwordHash: row.password_hash,
    salt: row.salt,
  };
}
