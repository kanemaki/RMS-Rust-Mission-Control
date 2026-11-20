import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-remote-'));
process.env.RMC_DATA_DIR = dataDir;

const { ServerRuntime } = await import('../src/process-manager.js');
const { normalizeServer, ValidationError } = await import('../src/store.js');

test('modo remoto conecta no RCON do host informado e não cria processo', async () => {
  const wss = new WebSocketServer({ port: 0, path: '/senha_remota' });
  await new Promise((resolve) => wss.once('listening', resolve));
  const { port } = wss.address();

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      socket.send(
        JSON.stringify({
          Identifier: message.Identifier,
          Message: 'Players: 3 / 100',
          Type: 'Generic',
          Name: 'Remote',
        }),
      );
    });
  });

  const server = normalizeServer({
    identity: 'remoto_1',
    mode: 'remote',
    host: '127.0.0.1',
    rconPort: port,
    rconPassword: 'senha_remota',
    autoUpdate: false,
    autoRestart: false,
  });

  const runtime = new ServerRuntime(server);
  const status = await runtime.start();
  assert.equal(status.state, 'running');
  assert.equal(status.mode, 'remote');
  assert.equal(status.pid, null);
  assert.equal(status.install, null);
  assert.equal(status.rconConnected, true);

  const response = await runtime.command('playerlist');
  assert.equal(response, 'Players: 3 / 100');
  assert.equal(runtime.players, 3);

  const stopped = await runtime.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.rconConnected, false);

  runtime.dispose();
  await new Promise((resolve) => wss.close(resolve));
});

test('modo remoto falha com mensagem clara quando o RCON não responde', async () => {
  const server = normalizeServer({
    identity: 'remoto_off',
    mode: 'remote',
    host: '127.0.0.1',
    rconPort: 1,
    rconPassword: 'senha_remota',
    autoUpdate: false,
    autoRestart: false,
  });

  const runtime = new ServerRuntime(server);
  await assert.rejects(() => runtime.start(), /Não foi possível conectar ao RCON/);
  assert.equal(runtime.state, 'error');
  runtime.dispose();
});

test('modo remoto rejeita atualização de arquivos', async () => {
  const server = normalizeServer({
    identity: 'remoto_upd',
    mode: 'remote',
    host: '127.0.0.1',
    rconPassword: 'senha_remota',
  });
  const runtime = new ServerRuntime(server);
  await assert.rejects(() => runtime.update(), /Servidor remoto/);
  runtime.dispose();
});

test('modo remoto conecta sem senha RCON', async () => {
  const wss = new WebSocketServer({ port: 0, path: '/' });
  await new Promise((resolve) => wss.once('listening', resolve));
  const { port } = wss.address();

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      socket.send(
        JSON.stringify({ Identifier: message.Identifier, Message: 'ok sem senha', Type: 'Generic', Name: 'Mock' }),
      );
    });
  });

  const server = normalizeServer({
    identity: 'remoto_sem_senha',
    mode: 'remote',
    host: '127.0.0.1',
    rconPort: port,
    rconPassword: '',
    autoUpdate: false,
    autoRestart: false,
  });
  assert.equal(server.installDir, '');

  const runtime = new ServerRuntime(server);
  const status = await runtime.start();
  assert.equal(status.state, 'running');
  assert.equal(status.rconConnected, true);

  const response = await runtime.command('status');
  assert.equal(response, 'ok sem senha');

  await runtime.stop();
  runtime.dispose();
  await new Promise((resolve) => wss.close(resolve));
});

test('host inválido é rejeitado na validação', () => {
  assert.throws(() => normalizeServer({ identity: 'x1', host: 'http://1.2.3.4' }), ValidationError);
  assert.throws(() => normalizeServer({ identity: 'x2', host: 'host:28016' }), ValidationError);
  assert.throws(() => normalizeServer({ identity: 'x3', host: 'a/b' }), ValidationError);
  const ok = normalizeServer({
    identity: 'x4',
    host: 'rust.exemplo.com',
    installDir: path.join(dataDir, 'rustds'),
    rconPassword: 'senha_segura_1',
  });
  assert.equal(ok.host, 'rust.exemplo.com');
  assert.equal(ok.mode, 'local');
});
