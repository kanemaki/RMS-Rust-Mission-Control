import crypto from 'node:crypto';
import fs from 'node:fs';
import { licenseFile } from './paths.js';
import { getMeta, setMeta } from './db.js';
import { ValidationError } from './errors.js';

/**
 * Licenciamento offline do Rust Mission Control.
 *
 * A licença é um JSON com um payload e uma assinatura Ed25519. A verificação
 * acontece inteiramente no agente, com a chave pública embutida abaixo — não há
 * chamada de rede, servidor de licenças nem phone-home. Quem tiver acesso físico
 * à máquina e ao código pode contornar; o objetivo é licença honesta, não DRM.
 */

// Chave pública Ed25519 (32 bytes, base64url) gerada por tools/license-keygen.cjs.
// A chave privada correspondente fica fora do repositório, com o dono do produto.
export const EMBEDDED_PUBLIC_KEY = 'lzGvTRWIwo65Ir-AIs9nSVcIWhF-G9LjMPyhWKp-0-A';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TRIAL_DAYS = 14;
const CLOCK_TOLERANCE_MS = DAY_MS;
const TRIAL_KEY = 'trial_started_at';

let publicKey = EMBEDDED_PUBLIC_KEY;

/** Usado pelos testes para trocar a chave; em produção fica sempre a embutida. */
export function setLicensePublicKey(key) {
  publicKey = key || EMBEDDED_PUBLIC_KEY;
}

/** JSON canônico: chaves ordenadas e sem espaços, para a assinatura não depender de formatação. */
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function publicKeyObject(raw = publicKey) {
  const bytes = Buffer.from(String(raw), 'base64url');
  if (bytes.length !== 32) throw new ValidationError('Chave pública de licença inválida.');
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]),
    format: 'der',
    type: 'spki',
  });
}

function parsePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('Licença sem payload.');
  }
  if (payload.v !== 1) throw new ValidationError('Versão de licença não suportada.');
  if (typeof payload.licenseId !== 'string' || !payload.licenseId.trim()) {
    throw new ValidationError('Licença sem licenseId.');
  }
  if (typeof payload.licensee !== 'string' || !payload.licensee.trim()) {
    throw new ValidationError('Licença sem titular.');
  }
  if (typeof payload.plan !== 'string' || !payload.plan.trim()) {
    throw new ValidationError('Licença sem plano.');
  }
  if (payload.maxServers !== null) {
    const max = Number(payload.maxServers);
    if (!Number.isInteger(max) || max < 1 || max > 10_000) {
      throw new ValidationError('maxServers deve ser um inteiro entre 1 e 10000, ou null.');
    }
  }
  const issued = Date.parse(String(payload.issuedAt ?? ''));
  if (!Number.isFinite(issued)) throw new ValidationError('issuedAt inválido.');
  if (payload.expiresAt !== null) {
    const expires = Date.parse(String(payload.expiresAt ?? ''));
    if (!Number.isFinite(expires)) throw new ValidationError('expiresAt inválido.');
    if (expires <= issued) throw new ValidationError('expiresAt precisa ser posterior a issuedAt.');
  }
  if (payload.installId !== null && typeof payload.installId !== 'string') {
    throw new ValidationError('installId inválido.');
  }
  return payload;
}

/**
 * Valida o texto de uma licença sem gravar nada.
 * Retorna { ok: true, payload } ou { ok: false, error }.
 */
export function verifyLicense(text, { key = publicKey } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    return { ok: false, error: 'Licença não é um JSON válido.' };
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.signature !== 'string') {
    return { ok: false, error: 'Licença sem assinatura.' };
  }
  let payload;
  try {
    payload = parsePayload(parsed.payload);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  let valid = false;
  try {
    valid = crypto.verify(
      null,
      Buffer.from(canonicalize(payload), 'utf8'),
      publicKeyObject(key),
      Buffer.from(parsed.signature, 'base64url'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: 'Assinatura da licença não confere.' };
  return { ok: true, payload };
}

function trialDays() {
  const raw = Number.parseInt(process.env.RMC_TRIAL_DAYS ?? String(DEFAULT_TRIAL_DAYS), 10);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_TRIAL_DAYS;
  return Math.min(raw, 365);
}

function trialInfo(now) {
  const days = trialDays();
  if (days === 0) return { days: 0, startedAt: null, endsAt: null, daysLeft: 0, active: false };
  let startedAt = Number(getMeta(TRIAL_KEY));
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    startedAt = now;
    setMeta(TRIAL_KEY, String(startedAt));
  }
  // Relógio atrasado não renova o trial: nunca conta mais que os dias cheios.
  const effectiveNow = Math.max(now, startedAt);
  const endsAt = startedAt + days * DAY_MS;
  const daysLeft = Math.max(0, Math.ceil((endsAt - effectiveNow) / DAY_MS));
  return { days, startedAt, endsAt, daysLeft, active: effectiveNow < endsAt };
}

function readLicenseFile() {
  if (!fs.existsSync(licenseFile)) return null;
  try {
    return fs.readFileSync(licenseFile, 'utf8');
  } catch (err) {
    return { error: `Não foi possível ler a licença: ${err.message}` };
  }
}

function baseStatus(now) {
  return {
    checkedAt: now,
    licensed: false,
    readOnly: false,
    state: 'none',
    licensee: null,
    licenseId: null,
    plan: null,
    maxServers: 1,
    issuedAt: null,
    expiresAt: null,
    daysLeft: null,
    error: null,
    trial: trialInfo(now),
  };
}

/** Estado atual da licença. Lê o arquivo a cada chamada (poucos bytes) e não faz rede. */
export function licenseStatus({ now = Date.now() } = {}) {
  const status = baseStatus(now);
  const raw = readLicenseFile();

  if (raw === null) {
    if (status.trial.active) {
      return { ...status, state: 'trial', readOnly: false, maxServers: null };
    }
    return {
      ...status,
      state: status.trial.days > 0 ? 'expired' : 'none',
      readOnly: true,
      error: status.trial.days > 0 ? 'O período de teste terminou. Aplique uma licença para voltar a editar.' : null,
    };
  }

  if (typeof raw === 'object' && raw.error) {
    return { ...status, state: 'invalid', readOnly: true, error: raw.error };
  }

  const result = verifyLicense(raw);
  if (!result.ok) {
    return { ...status, state: 'invalid', readOnly: true, error: result.error };
  }

  const payload = result.payload;
  const expiresAt = payload.expiresAt === null ? null : Date.parse(payload.expiresAt);
  const daysLeft = expiresAt === null ? null : Math.max(0, Math.ceil((expiresAt - now) / DAY_MS));
  const common = {
    ...status,
    licensed: true,
    licensee: payload.licensee,
    licenseId: payload.licenseId,
    plan: payload.plan,
    maxServers: payload.maxServers,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    daysLeft,
  };

  if (expiresAt !== null && expiresAt <= now) {
    return { ...common, state: 'expired', readOnly: true, error: 'A licença expirou. Aplique uma nova licença para voltar a editar.' };
  }
  return { ...common, state: 'valid', readOnly: false };
}

/** Valida e grava a licença colada pelo usuário. Lança ValidationError se inválida. */
export function applyLicense(text) {
  const result = verifyLicense(text);
  if (!result.ok) throw new ValidationError(result.error);
  const normalized = JSON.stringify({ payload: result.payload, signature: JSON.parse(String(text)).signature }, null, 2);
  const tmp = `${licenseFile}.tmp`;
  fs.writeFileSync(tmp, `${normalized}\n`, 'utf8');
  fs.renameSync(tmp, licenseFile);
  return licenseStatus();
}

/** Remove a licença aplicada; o trial continua contando desde o primeiro boot. */
export function removeLicense() {
  if (!fs.existsSync(licenseFile)) return false;
  fs.unlinkSync(licenseFile);
  return true;
}

/** Bloqueia a criação de servidor acima do limite da licença válida. */
export function assertServerLimit(currentCount) {
  const status = licenseStatus();
  if (status.state !== 'valid' || status.maxServers === null) return;
  if (currentCount >= status.maxServers) {
    throw new ValidationError(`A licença permite até ${status.maxServers} servidor(es).`);
  }
}
