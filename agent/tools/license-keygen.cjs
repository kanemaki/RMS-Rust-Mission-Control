#!/usr/bin/env node
/**
 * Gera o par de chaves Ed25519 usado para assinar licenças do Rust Mission Control.
 *
 * Rode UMA vez. A chave privada fica fora do repositório (padrão:
 * %USERPROFILE%\.rms-license\private-key.pem) e nunca deve ser versionada,
 * copiada para o Dockerfile ou enviada a clientes. A chave pública é impressa
 * no terminal para ser colada em agent/src/license.js (constante EMBEDDED_PUBLIC_KEY).
 *
 * Uso:
 *   node tools/license-keygen.cjs [--out C:\caminho\private-key.pem] [--force]
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

const out =
  arg('out') ||
  process.env.RMS_LICENSE_KEY ||
  path.join(os.homedir(), '.rms-license', 'private-key.pem');
const force = process.argv.includes('--force');

if (fs.existsSync(out) && !force) {
  console.error(`Já existe uma chave em ${out}. Use --force para sobrescrever (as licenças antigas deixariam de valer).`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' });
const publicDer = publicKey.export({ format: 'der', type: 'spki' });
const raw = publicDer.subarray(publicDer.length - 32);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, privatePem, { mode: 0o600 });

console.log('Chave privada gravada em:');
console.log(`  ${out}`);
console.log('Guarde esse arquivo fora do repositório e faça backup. Sem ele não é possível emitir licenças.');
console.log('');
console.log('Chave pública (cole em agent/src/license.js como EMBEDDED_PUBLIC_KEY):');
console.log(`  ${raw.toString('base64url')}`);
console.log('');
console.log('Chave pública em PEM (referência):');
console.log(publicKey.export({ format: 'pem', type: 'spki' }).trim());
