import fs from 'node:fs';
import path from 'node:path';

const IDENTITY_RE = /^[A-Za-z0-9_-]{1,32}$/;
const BLUEPRINT_FILE_RE = /^player\.blueprints(?:\..*)?$/i;

export function nextMonthlyWipeAt({ dayOfMonth, time }, from = Date.now()) {
  const [hour, minute] = String(time).split(':').map(Number);
  const current = new Date(from);
  let year = current.getFullYear();
  let month = current.getMonth();
  let candidate = new Date(year, month, dayOfMonth, hour, minute, 0, 0);
  if (candidate.getTime() <= from) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
    candidate = new Date(year, month, dayOfMonth, hour, minute, 0, 0);
  }
  return candidate.getTime();
}

export function clearWipeData(server, type) {
  if (!IDENTITY_RE.test(String(server.identity ?? ''))) throw new Error('Identidade inválida para wipe.');
  if (!['map', 'blueprints', 'full'].includes(type)) throw new Error('Tipo de wipe inválido.');

  const installRoot = path.resolve(server.installDir);
  const serverRoot = path.join(installRoot, 'server');
  const identityDir = path.resolve(serverRoot, server.identity);
  if (!identityDir.startsWith(`${path.resolve(serverRoot)}${path.sep}`)) {
    throw new Error('Pasta da identidade fora da instalação do servidor.');
  }

  let removed = 0;
  if (type === 'map' || type === 'full') {
    const saveDir = path.join(identityDir, 'save');
    if (fs.existsSync(saveDir)) {
      for (const entry of fs.readdirSync(saveDir)) {
        fs.rmSync(path.join(saveDir, entry), { recursive: true, force: true });
        removed += 1;
      }
    }
  }

  if (type === 'blueprints' || type === 'full') {
    if (fs.existsSync(identityDir)) {
      for (const entry of fs.readdirSync(identityDir)) {
        if (!BLUEPRINT_FILE_RE.test(entry)) continue;
        fs.rmSync(path.join(identityDir, entry), { recursive: true, force: true });
        removed += 1;
      }
    }
  }
  return removed;
}
