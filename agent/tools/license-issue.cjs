#!/usr/bin/env node
/**
 * Emite uma licença assinada (Ed25519) para o Rust Mission Control.
 *
 * Roda só na máquina do dono do produto, com a chave privada gerada por
 * tools/license-keygen.cjs. Não precisa de servidor no ar: o JSON impresso é
 * entregue ao cliente, que cola no painel (aba Licença).
 *
 * Uso:
 *   node tools/license-issue.cjs --licensee "Fulano" --plan pro --servers 10 --days 365
 *   node tools/license-issue.cjs --licensee "Fulano" --plan pro --servers 10 --days 0 --out licenca.json
 *
 * Opções:
 *   --licensee <nome>     titular (obrigatório)
 *   --plan <nome>         plano (padrão: pro)
 *   --servers <n>         máximo de servidores (padrão: 10; "unlimited"/0 = sem limite)
 *   --days <n>            validade em dias (padrão: 365; 0 = perpétua)
 *   --license-id <id>     id da licença (padrão: RMS-XXXX-XXXX)
 *   --key-id <id>         identificador da chave (padrão: rms-2026)
 *   --install-id <id>     vínculo opcional com uma instalação (padrão: null)
 *   --key <arquivo>       chave privada PEM (padrão: RMS_LICENSE_KEY ou ~/.rms-license/private-key.pem)
 *   --out <arquivo>       grava o JSON no arquivo em vez de imprimir
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function randomLicenseId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = () =>
    Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `RMS-${block()}-${block()}`;
}

const licensee = arg('licensee');
if (!licensee) {
  console.error('Informe o titular: --licensee "Nome do cliente"');
  process.exit(1);
}

const keyPath =
  arg('key') || process.env.RMS_LICENSE_KEY || path.join(os.homedir(), '.rms-license', 'private-key.pem');
if (!fs.existsSync(keyPath)) {
  console.error(`Chave privada não encontrada em ${keyPath}. Rode tools/license-keygen.cjs primeiro.`);
  process.exit(1);
}

const serversRaw = String(arg('servers', '10')).toLowerCase();
const maxServers =
  serversRaw === 'unlimited' || serversRaw === 'ilimitado' || serversRaw === '0'
    ? null
    : Number.parseInt(serversRaw, 10);
if (maxServers !== null && (!Number.isInteger(maxServers) || maxServers < 1)) {
  console.error('--servers deve ser um inteiro positivo, 0 ou "unlimited".');
  process.exit(1);
}

const days = Number.parseInt(String(arg('days', '365')), 10);
if (!Number.isInteger(days) || days < 0) {
  console.error('--days deve ser um inteiro >= 0 (0 = perpétua).');
  process.exit(1);
}

const now = new Date();
const expiresAt = days === 0 ? null : new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

const payload = {
  v: 1,
  keyId: String(arg('key-id', 'rms-2026')),
  licenseId: String(arg('license-id', randomLicenseId())),
  licensee: String(licensee).trim(),
  plan: String(arg('plan', 'pro')).trim(),
  maxServers,
  issuedAt: now.toISOString(),
  expiresAt,
  installId: arg('install-id') || null,
};

const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
const signature = crypto.sign(null, Buffer.from(canonicalize(payload), 'utf8'), privateKey).toString('base64url');
const license = { payload, signature };
const text = `${JSON.stringify(license, null, 2)}\n`;

const out = arg('out');
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, text, 'utf8');
  console.log(`Licença gravada em ${path.resolve(out)}`);
  console.log(`Titular: ${payload.licensee} · ${payload.licenseId} · ${payload.maxServers ?? 'ilimitado'} servidor(es) · ${expiresAt ?? 'perpétua'}`);
} else {
  process.stdout.write(text);
}
