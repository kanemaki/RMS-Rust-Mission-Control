import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-samples-'));
process.env.RMC_DATA_DIR = dataDir;

const { DatabaseSync } = await import('node:sqlite');
const { getDb, closeDb, recordSample, listSamples, listSamplesRange, pruneSamples } = await import('../src/db.js');
const { ValidationError } = await import('../src/errors.js');
const { sampleProcess } = await import('../src/procstats.js');

test('banco antigo sem cpu/mem recebe as colunas por migração', () => {
  const legacyDir = path.join(dataDir, 'legacy');
  fs.mkdirSync(legacyDir, { recursive: true });
  const dbFile = path.join(legacyDir, 'mission-control.db');
  new DatabaseSync(dbFile).close();
  // Simula um banco criado antes das colunas cpu/mem existirem.
  new DatabaseSync(dbFile).exec(`
    CREATE TABLE samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      state TEXT NOT NULL,
      players INTEGER
    );
  `);
  process.env.RMC_DATA_DIR = legacyDir;
  getDb().prepare("INSERT INTO samples (server_id, ts, state, players) VALUES ('antigo', ?, 'running', 4)").run(Date.now());
  recordSample('antigo', 'running', 6, 12.5, 2048);
  const rows = listSamples('antigo', 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].cpu, 12.5);
  assert.equal(rows[1].mem, 2048);
  closeDb();
  process.env.RMC_DATA_DIR = dataDir;
  getDb();
});

test('listSamplesRange agrega em blocos com média de jogadores/memória e CPU máxima', () => {
  const minute = 60_000;
  const base = Math.floor((Date.now() - 60 * minute) / (30 * minute)) * (30 * minute);
  // 60 minutos de amostras: 3 jogadores nos primeiros 30 min, 9 nos últimos 30.
  for (let i = 0; i < 60; i += 1) {
    getDb()
      .prepare('INSERT INTO samples (server_id, ts, state, players, cpu, mem) VALUES (?, ?, ?, ?, ?, ?)')
      .run('agg', base + i * minute, 'running', i < 30 ? 3 : 9, 60 + i, 1000 + i * 10);
  }
  // Uma amostra offline no meio: players NULL não pode derrubar a média do bloco.
  getDb()
    .prepare("INSERT INTO samples (server_id, ts, state, players, cpu, mem) VALUES ('agg', ?, 'stopped', NULL, NULL, NULL)")
    .run(base + 15 * minute);

  const blocks = listSamplesRange('agg', { since: base, until: base + 60 * minute, bucketMs: 30 * minute });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].players, 3);
  assert.equal(blocks[1].players, 9);
  assert.equal(blocks[0].state, 'running');
  assert.equal(blocks[0].cpu, 89); // maior cpu do primeiro bloco (60..89)
  assert.equal(blocks[1].cpu, 119);
  assert.equal(blocks[0].mem, 1145); // média de 1000+i*10, i=0..29 (a linha NULL é ignorada)

  const empty = listSamplesRange('outro', { since: base, until: base + 60 * minute, bucketMs: 30 * minute });
  assert.deepEqual(empty, []);

  assert.throws(() => listSamplesRange('agg', { since: base, until: base, bucketMs: 1000 }), ValidationError);
});

test('pruneSamples remove apenas amostras mais antigas que a retenção', () => {
  const now = Date.now();
  getDb().prepare("INSERT INTO samples (server_id, ts, state, players) VALUES ('prune', ?, 'stopped', 0)").run(now - 40 * 24 * 60 * 60 * 1000);
  getDb().prepare("INSERT INTO samples (server_id, ts, state, players) VALUES ('prune', ?, 'running', 1)").run(now - 10 * 24 * 60 * 60 * 1000);
  pruneSamples();
  const rows = listSamples('prune', 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].players, 1);
});

test('sampleProcess lê cpu e memória de um processo vivo e devolve null para pid inválido', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    const stats = await sampleProcess(child.pid);
    assert.ok(stats, 'sampleProcess devolveu null para um processo vivo');
    assert.ok(stats.cpu >= 0);
    assert.ok(stats.mem > 0);
  } finally {
    child.kill();
  }
  assert.equal(await sampleProcess(999999), null);
  assert.equal(await sampleProcess(0), null);
  assert.equal(await sampleProcess(null), null);
});

test('rota /samples devolve séries agregadas por range e valida o intervalo', async () => {
  const { default: express } = await import('express');
  const { createApi } = await import('../src/api.js');
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', createApi({ secureCookies: false }));
  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => httpServer.once('listening', resolve));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  try {
    const setupRes = await fetch(`${base}/api/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'senha-samples-forte' }),
    });
    const cookie = (setupRes.headers.get('set-cookie') ?? '').split(';')[0];
    assert.ok(cookie, 'sessão não recebida no setup');

    const createRes = await fetch(`${base}/api/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-rmc-request': '1' },
      body: JSON.stringify({ identity: 'metrics_srv', installDir: path.join(dataDir, 'rustds') }),
    });
    assert.equal(createRes.status, 201, `falha ao criar servidor: ${await createRes.text()}`);

    recordSample('metrics_srv', 'running', 7, 120.5, 4 * 1024 ** 3);
    recordSample('metrics_srv', 'running', 3, 130.0, 4.2 * 1024 ** 3);

    const rangeRes = await fetch(`${base}/api/servers/metrics_srv/samples?range=24h`, { headers: { cookie } });
    assert.equal(rangeRes.status, 200);
    const body = await rangeRes.json();
    assert.equal(body.range, '24h');
    assert.ok(body.bucketMs >= 60_000);
    assert.equal(body.samples.length, 1);
    assert.equal(body.samples[0].players, 5);
    assert.equal(body.samples[0].cpu, 130.0);
    assert.ok(body.samples[0].mem > 4 * 1024 ** 3);

    const invalid = await fetch(`${base}/api/servers/metrics_srv/samples?range=2h`, { headers: { cookie } });
    assert.equal(invalid.status, 400);

    const raw = await fetch(`${base}/api/servers/metrics_srv/samples?limit=1`, { headers: { cookie } });
    const rawBody = await raw.json();
    assert.ok(Array.isArray(rawBody));
    assert.equal(rawBody.length, 1);
    assert.equal(rawBody[0].players, 3);
  } finally {
    httpServer.close();
  }
});
