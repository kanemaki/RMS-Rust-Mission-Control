import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const agentRoot = path.resolve(here, '..');
export const repoRoot = path.resolve(agentRoot, '..');

export const dataDir = process.env.RMC_DATA_DIR
  ? path.resolve(process.env.RMC_DATA_DIR)
  : path.join(agentRoot, 'data');

export const publicDir = path.join(agentRoot, 'public');
export const configFile = path.join(dataDir, 'config.json');
export const dbFile = path.join(dataDir, 'mission-control.db');
export const logsDir = path.join(dataDir, 'logs');
export const backupsDir = path.join(dataDir, 'backups');

export function ensureDirs() {
  for (const dir of [dataDir, logsDir, backupsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function serverLogsDir(serverId) {
  const dir = path.join(logsDir, serverId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function serverBackupsDir(serverId) {
  const dir = path.join(backupsDir, serverId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
