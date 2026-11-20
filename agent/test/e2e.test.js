import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(here, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-e2e-'));
const port = 18000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;

test('fluxo completo: setup, login, criar, iniciar, logs e parar', async (t) => {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: agentRoot,
    env: { ...process.env, RMC_DATA_DIR: dataDir, RMC_PORT: String(port), RMC_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk.toString()));
  child.stderr.on('data', (chunk) => (output += chunk.toString()));

  t.after(() => {
    child.kill();
  });

  await waitFor(async () => {
    try {
      const res = await fetch(`${base}/api/health`);
      return res.ok;
    } catch {
      return false;
    }
  }, 15000, () => output);

  const setupStatus = await json(`${base}/api/setup`);
  assert.equal(setupStatus.needsSetup, true);

  const setupRes = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'senha-e2e-forte' }),
  });
  assert.equal(setupRes.status, 200);
  const cookie = setupRes.headers.getSetCookie()[0].split(';')[0];

  const servers = await json(`${base}/api/servers`, { cookie });
  assert.ok(Array.isArray(servers));

  const installDir = path.join(dataDir, 'rustds');
  fs.mkdirSync(installDir, { recursive: true });
  const created = await json(`${base}/api/servers`, {
    method: 'POST',
    cookie,
    body: {
      identity: 'e2e_test',
      name: 'E2E',
      installDir,
      steamCmdDir: path.join(dataDir, 'steam'),
      executable: process.execPath,
      executableArgs: [path.join(here, 'mock-server.js')],
      autoUpdate: false,
      autoRestart: false,
      rconPort: 28998,
      rconPassword: 'senha_e2e_1',
    },
  });
  assert.equal(created.id, 'e2e_test');

  const started = await json(`${base}/api/servers/e2e_test/start`, {
    method: 'POST',
    cookie,
    body: { skipUpdate: true },
  });
  assert.equal(started.state, 'starting');

  await waitFor(async () => {
    const server = await json(`${base}/api/servers/e2e_test`, { cookie });
    return server.status?.state === 'running';
  }, 15000, () => output);

  const logs = await json(`${base}/api/servers/e2e_test/logs`, { cookie });
  assert.ok(logs.some((entry) => entry.line.includes('Server startup complete')));

  const stopped = await json(`${base}/api/servers/e2e_test/stop`, { method: 'POST', cookie, body: {} });
  assert.equal(stopped.state, 'stopped');

  const audit = await json(`${base}/api/audit`, { cookie });
  assert.ok(audit.some((entry) => entry.action === 'server_start'));

  const unauthorized = await fetch(`${base}/api/servers`);
  assert.equal(unauthorized.status, 401);
});

async function json(url, { method = 'GET', cookie, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie, 'x-rmc-request': '1' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function waitFor(predicate, timeoutMs, dump) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timeout esperando condição\n${dump?.() ?? ''}`);
}
