import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-unit-'));
process.env.RMC_DATA_DIR = dataDir;

const store = await import('../src/store.js');
const cfg = await import('../src/cfg.js');
const auth = await import('../src/auth.js');

test('config padrão respeita a ausência de instalação local', () => {
  const config = store.loadConfig();
  assert.ok(Array.isArray(config.servers));
  const detected = store.detectInstall();
  if (detected) {
    assert.equal(config.servers.length, 1);
    assert.equal(config.servers[0].installDir, detected.installDir);
    assert.ok(config.servers[0].rconPassword.length >= 8);
  } else {
    assert.equal(config.servers.length, 0);
  }
});

test('lista vazia de servidores não ressuscita o servidor padrão', () => {
  const config = store.loadConfig();
  config.servers = [];
  store.saveConfig(config);
  store.reloadConfig();
  assert.deepEqual(store.loadConfig().servers, []);
});

test('servidor local exige pasta de instalação', () => {
  assert.throws(
    () => store.normalizeServer({ identity: 'sem_pasta', rconPassword: 'senha_segura_1' }),
    /pasta de instalação/,
  );
  const remoto = store.normalizeServer({
    identity: 'sem_pasta_remoto',
    mode: 'remote',
    host: '127.0.0.1',
    rconPassword: 'senha_segura_1',
  });
  assert.equal(remoto.installDir, '');
});

test('normaliza e rejeita valores inválidos', () => {
  assert.throws(() => store.normalizeServer({ identity: 'nome com espaço' }), store.ValidationError);
  assert.throws(() => store.normalizeServer({ port: 70000 }), store.ValidationError);
  assert.throws(() => store.normalizeServer({ rconPassword: 'senha com espaço' }), store.ValidationError);
  assert.throws(() => store.normalizeServer({ rconPassword: 'senha@123' }), store.ValidationError);

  const semSenha = store.normalizeServer({
    identity: 'sem_senha',
    mode: 'remote',
    host: '127.0.0.1',
    rconPassword: '',
  });
  assert.equal(semSenha.rconPassword, '');

  const server = store.normalizeServer({
    identity: 'teste_1',
    installDir: path.join(dataDir, 'rustds'),
    port: 28015,
    rconPort: 28016,
    rconPassword: 'senha_segura_1',
  });
  assert.equal(server.identity, 'teste_1');
  assert.equal(server.port, 28015);
});

test('server.cfg faz roundtrip preservando linhas desconhecidas', () => {
  const server = store.normalizeServer({
    identity: 'cfg_test',
    installDir: path.join(dataDir, 'rustds'),
    rconPassword: 'senha_segura_1',
  });
  const file = cfg.configPath(server);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'server.hostname "Antigo"\ncustom.key "preservar"\n', 'utf8');

  const written = cfg.writeConfig(server, { 'server.hostname': 'Novo Nome', 'server.maxplayers': 25 });
  assert.equal(written.values['server.hostname'], 'Novo Nome');
  assert.equal(written.values['server.maxplayers'], 25);
  assert.ok(written.unknown.some((line) => line.includes('custom.key')));

  assert.throws(() => cfg.writeConfig(server, { 'chave.invalida': 1 }), store.ValidationError);
  assert.throws(() => cfg.writeConfig(server, { 'server.maxplayers': 5000 }), store.ValidationError);
});

test('senha do painel usa scrypt e sessão expira', () => {
  assert.equal(auth.needsSetup(), true);
  assert.throws(() => auth.setPassword('curta'), store.ValidationError);
  auth.setPassword('senha-muito-forte');
  assert.equal(auth.needsSetup(), false);
  assert.equal(auth.verifyPassword('senha-muito-forte'), true);
  assert.equal(auth.verifyPassword('errada'), false);

  const { token } = auth.createSession({ ip: '127.0.0.1', userAgent: 'teste' });
  assert.ok(auth.readSession(token));
  auth.destroySession(token);
  assert.equal(auth.readSession(token), null);
});
