import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { serverBackupsDir } from './paths.js';
import { ConflictError } from './errors.js';
import { ValidationError } from './store.js';

const NAME_RE = /^[A-Za-z0-9._-]+\.tar\.gz$/;

export function identityDir(server) {
  return path.join(server.installDir, 'server', server.identity);
}

export function listBackups(server) {
  const dir = serverBackupsDir(server.id);
  return fs
    .readdirSync(dir)
    .filter((name) => NAME_RE.test(name))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, createdAt: stat.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function createBackup(server, runtime, { label = 'manual' } = {}) {
  const source = identityDir(server);
  if (!fs.existsSync(source)) {
    throw new ValidationError(`A pasta da identidade "${server.identity}" ainda não existe. Inicie o servidor uma vez.`);
  }
  if (runtime?.state === 'running' || runtime?.state === 'starting') {
    try {
      await runtime.command('save');
    } catch {
      /* segue com o backup mesmo sem save confirmado */
    }
  }

  const dir = serverBackupsDir(server.id);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeLabel = String(label).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'manual';
  const name = `${stamp}-${safeLabel}.tar.gz`;
  const target = path.join(dir, name);

  const result = await runTar(['-czf', target, '-C', path.dirname(source), path.basename(source)]);
  if (!result.ok) {
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    throw new Error(`Falha ao criar backup: ${result.error ?? `tar código ${result.code}`}`);
  }
  const stat = fs.statSync(target);
  return { name, size: stat.size, createdAt: stat.mtimeMs };
}

export async function restoreBackup(server, runtime, name) {
  if (!NAME_RE.test(name)) throw new ValidationError('Nome de backup inválido.');
  const file = path.join(serverBackupsDir(server.id), name);
  if (!fs.existsSync(file)) throw new ValidationError('Backup não encontrado.');
  if (runtime && runtime.state !== 'stopped' && runtime.state !== 'error') {
    throw new ConflictError('Pare o servidor antes de restaurar um backup.');
  }

  const target = identityDir(server);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });

  // Segurança: guarda o estado atual antes de sobrescrever.
  let safety = null;
  if (fs.existsSync(target)) safety = await createBackup(server, null, { label: 'pre-restore' });

  const temp = path.join(parent, `.restore-${Date.now()}`);
  fs.mkdirSync(temp, { recursive: true });
  const extracted = await runTar(['-xzf', file, '-C', temp]);
  if (!extracted.ok) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw new Error(`Falha ao extrair backup: ${extracted.error ?? `tar código ${extracted.code}`}`);
  }

  const restored = path.join(temp, server.identity);
  if (!fs.existsSync(restored)) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw new Error('O backup não contém a pasta da identidade esperada.');
  }

  const old = `${target}.old-${Date.now()}`;
  if (fs.existsSync(target)) fs.renameSync(target, old);
  try {
    fs.renameSync(restored, target);
  } catch (err) {
    if (fs.existsSync(old)) fs.renameSync(old, target);
    fs.rmSync(temp, { recursive: true, force: true });
    throw new Error(`Falha ao mover o backup restaurado: ${err.message}`);
  }
  fs.rmSync(temp, { recursive: true, force: true });
  fs.rmSync(old, { recursive: true, force: true });

  return { restored: name, safetyBackup: safety?.name ?? null };
}

export function deleteBackup(server, name) {
  if (!NAME_RE.test(name)) throw new ValidationError('Nome de backup inválido.');
  const file = path.join(serverBackupsDir(server.id), name);
  if (!fs.existsSync(file)) throw new ValidationError('Backup não encontrado.');
  fs.rmSync(file, { force: true });
  return true;
}

function runTar(args) {
  return new Promise((resolve) => {
    const child = spawn('tar', args, { windowsHide: true });
    let error = '';
    child.stderr.on('data', (chunk) => {
      error += chunk.toString();
    });
    child.on('error', (err) => resolve({ ok: false, code: null, error: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code, error: error.trim() }));
  });
}
