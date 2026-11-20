import fs from 'node:fs';
import path from 'node:path';
import { listBackups } from './backups.js';
import { serverBackupsDir } from './paths.js';

const SCHEDULED_RE = /-scheduled\.tar\.gz$/;

export function nextDailyBackupAt({ time }, from = Date.now()) {
  const [hour, minute] = String(time).split(':').map(Number);
  const current = new Date(from);
  let candidate = new Date(current.getFullYear(), current.getMonth(), current.getDate(), hour, minute, 0, 0);
  if (candidate.getTime() <= from) {
    candidate = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1, hour, minute, 0, 0);
  }
  return candidate.getTime();
}

// Mantém os `keep` backups agendados mais recentes; nunca toca em backups
// manuais, pré-restauração ou do wipe agendado.
export function pruneScheduledBackups(server, keep) {
  const scheduled = listBackups(server).filter((backup) => SCHEDULED_RE.test(backup.name));
  if (scheduled.length <= keep) return [];
  const excess = scheduled.slice(keep);
  for (const backup of excess) {
    fs.rmSync(path.join(serverBackupsDir(server.id), backup.name), { force: true });
  }
  return excess.map((backup) => backup.name);
}
