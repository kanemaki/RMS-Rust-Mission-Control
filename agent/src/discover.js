import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './cfg.js';
import { ValidationError } from './store.js';

const IDENTITY_RE = /^[A-Za-z0-9_-]{1,32}$/;
const EXECUTABLES = ['RustDedicated.exe', 'RustDedicated'];

/**
 * Inspeciona uma instalação existente do Rust Dedicated e lista as identidades
 * (pastas em server/) com os valores já presentes no server.cfg de cada uma.
 */
export function scanInstall(installDir) {
  const raw = String(installDir ?? '').trim();
  if (!raw) throw new ValidationError('Informe a pasta de instalação.');
  const dir = path.resolve(raw);
  if (!fs.existsSync(dir)) throw new ValidationError(`Pasta não encontrada: ${dir}`);
  if (!fs.statSync(dir).isDirectory()) throw new ValidationError(`Não é uma pasta: ${dir}`);

  const executable = EXECUTABLES.find((name) => fs.existsSync(path.join(dir, name))) ?? null;
  const serverRoot = path.join(dir, 'server');
  const identities = [];

  if (fs.existsSync(serverRoot)) {
    for (const entry of fs.readdirSync(serverRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !IDENTITY_RE.test(entry.name)) continue;
      const identityDir = path.join(serverRoot, entry.name);
      const cfg = readConfig({ installDir: dir, identity: entry.name });
      identities.push({
        identity: entry.name,
        configPath: cfg.path,
        hasConfig: cfg.exists,
        hasSave: fs.existsSync(path.join(identityDir, 'save')),
        values: cfg.values,
      });
    }
  }

  identities.sort((a, b) => a.identity.localeCompare(b.identity));

  return {
    installDir: dir,
    executable,
    installed: Boolean(executable),
    identities,
  };
}
