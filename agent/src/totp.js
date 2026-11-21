import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DIGITS = 6;
const PERIOD_SECONDS = 30;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input) {
  const clean = String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Segredo TOTP inválido.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function totp(secret, { now = Date.now(), step = 0 } = {}) {
  const counter = Math.floor(now / 1000 / PERIOD_SECONDS) + step;
  return hotp(secret, counter);
}

export function verifyTotp(secret, code, { now = Date.now(), window = 1 } = {}) {
  const normalized = normalizeCode(code);
  if (normalized.length !== DIGITS) return false;
  for (let step = -window; step <= window; step += 1) {
    const expected = Buffer.from(totp(secret, { now, step }));
    const actual = Buffer.from(normalized);
    if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) return true;
  }
  return false;
}

export function normalizeCode(input) {
  return String(input ?? '').replace(/\D/g, '').slice(0, DIGITS);
}

export function otpauthUrl({ secret, account = 'painel', issuer = 'Rust Mission Control' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let index = 0; index < count; index += 1) {
    let raw = '';
    for (const byte of crypto.randomBytes(8)) raw += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return codes;
}

export function hashRecoveryCode(code) {
  const normalized = String(code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export const TOTP_PERIOD_SECONDS = PERIOD_SECONDS;
export const TOTP_DIGITS = DIGITS;
