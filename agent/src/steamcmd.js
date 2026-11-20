import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLineSplitter } from './lines.js';

/**
 * Executa o SteamCMD para instalar/atualizar o Rust Dedicated Server (app 258550).
 * Retorna { ok, code } e transmite a saída linha a linha.
 */
export function updateServerFiles(server, { onLine, timeoutMs = 45 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    if (!server.steamCmdDir) {
      resolve({ ok: false, code: null, error: 'Pasta do SteamCMD não configurada para este servidor.' });
      return;
    }
    const steamCmd = path.join(server.steamCmdDir, process.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd.sh');
    if (!fs.existsSync(steamCmd)) {
      resolve({ ok: false, code: null, error: `SteamCMD não encontrado em ${steamCmd}` });
      return;
    }
    if (!fs.existsSync(server.installDir)) {
      fs.mkdirSync(server.installDir, { recursive: true });
    }

    const args = [
      '+force_install_dir',
      server.installDir,
      '+login',
      'anonymous',
      '+app_update',
      '258550',
      'validate',
      '+quit',
    ];

    const child = spawn(steamCmd, args, {
      cwd: server.steamCmdDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const emit = (stream) => (line) => onLine?.({ stream, line });
    const out = createLineSplitter(emit('stdout'));
    const err = createLineSplitter(emit('stderr'));
    child.stdout.on('data', out.push);
    child.stderr.on('data', err.push);

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out.flush();
      err.flush();
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignora */
      }
      finish({ ok: false, code: null, error: 'SteamCMD excedeu o tempo limite.' });
    }, timeoutMs);

    child.on('error', (error) => finish({ ok: false, code: null, error: error.message }));
    child.on('close', (code) => finish({ ok: code === 0, code }));
  });
}
