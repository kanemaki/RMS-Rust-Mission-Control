import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLineSplitter } from './lines.js';
import { dataDir } from './paths.js';

const IS_WIN = process.platform === 'win32';
const STEAMCMD_URL = IS_WIN
  ? 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip'
  : 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz';

export const sharedSteamCmdDir = path.join(dataDir, 'steamcmd');

export function steamCmdBinary(dir) {
  return path.join(dir, IS_WIN ? 'steamcmd.exe' : 'steamcmd.sh');
}

async function downloadSteamCmd(dir, onLine) {
  onLine?.({ stream: 'stdout', line: `SteamCMD não encontrado. Baixando de ${STEAMCMD_URL}...` });
  fs.mkdirSync(dir, { recursive: true });
  const res = await fetch(STEAMCMD_URL);
  if (!res.ok) throw new Error(`Download do SteamCMD falhou (HTTP ${res.status}).`);
  const archive = path.join(dir, IS_WIN ? 'steamcmd.zip' : 'steamcmd.tar.gz');
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xf', archive, '-C', dir], { windowsHide: true });
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Falha ao extrair o SteamCMD (tar código ${code}).`))));
  });
  fs.rmSync(archive, { force: true });
  if (!fs.existsSync(steamCmdBinary(dir))) throw new Error('SteamCMD baixado, mas o executável não foi encontrado.');
}

/**
 * Executa o SteamCMD para instalar/atualizar o Rust Dedicated Server (app 258550).
 * Retorna { ok, code } e transmite a saída linha a linha.
 */
async function updateOnce(server, { onLine, timeoutMs = 45 * 60 * 1000 } = {}) {
  const steamCmdDir = server.steamCmdDir || sharedSteamCmdDir;
  const steamCmd = steamCmdBinary(steamCmdDir);
  if (!fs.existsSync(steamCmd)) {
    try {
      await downloadSteamCmd(steamCmdDir, onLine);
    } catch (error) {
      return { ok: false, code: null, error: `SteamCMD não encontrado em ${steamCmd} e o download automático falhou: ${error.message}` };
    }
  }
  return new Promise((resolve) => {
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
      cwd: steamCmdDir,
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

/**
 * O SteamCMD recém-baixado se auto-atualiza na primeira execução e costuma sair
 * com código 7 ("Update complete, launching..."). Nesse caso basta rodar de novo.
 */
export async function updateServerFiles(server, opts = {}) {
  let result;
  for (let attempt = 1; attempt <= 3; attempt++) {
    result = await updateOnce(server, opts);
    if (result.ok || result.code === null) return result;
    opts.onLine?.({ stream: 'stdout', line: `SteamCMD retornou código ${result.code}. Tentativa ${attempt}/3${attempt < 3 ? ', repetindo...' : '.'}` });
  }
  return result;
}
