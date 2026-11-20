import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-proc-'));
process.env.RMC_DATA_DIR = dataDir;

const { ServerRuntime } = await import('../src/process-manager.js');
const { normalizeServer } = await import('../src/store.js');

const here = path.dirname(fileURLToPath(import.meta.url));

test('inicia, detecta pronto e encerra o processo', async () => {
  const installDir = path.join(dataDir, 'rustds');
  fs.mkdirSync(installDir, { recursive: true });

  const server = normalizeServer({
    identity: 'proc_test',
    installDir,
    steamCmdDir: path.join(dataDir, 'steam'),
    executable: process.execPath,
    executableArgs: [path.join(here, 'mock-server.js')],
    extraArgs: [],
    autoUpdate: false,
    autoRestart: false,
    rconPassword: 'senha_segura_1',
    rconPort: 28999,
  });

  const runtime = new ServerRuntime(server);
  const status = await runtime.start({ skipUpdate: true });
  assert.equal(status.state, 'starting');
  assert.ok(status.pid);

  await waitFor(() => runtime.state === 'running', 10000);
  assert.equal(runtime.state, 'running');

  const stopped = await runtime.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(runtime.pid, null);
  runtime.dispose();
});

test('start falha com mensagem clara quando o executável não existe', async () => {
  const server = normalizeServer({
    identity: 'missing_exe',
    installDir: path.join(dataDir, 'vazio'),
    steamCmdDir: path.join(dataDir, 'steam'),
    executable: 'RustDedicated.exe',
    autoUpdate: false,
    rconPassword: 'senha_segura_1',
  });
  fs.mkdirSync(server.installDir, { recursive: true });

  const runtime = new ServerRuntime(server);
  await assert.rejects(() => runtime.start({ skipUpdate: true }), /Executável não encontrado/);
  assert.equal(runtime.state, 'error');
  runtime.dispose();
});

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timeout esperando condição');
}
