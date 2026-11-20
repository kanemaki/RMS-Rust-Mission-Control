import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-wipe-'));
process.env.RMC_DATA_DIR = dataDir;

const { normalizeServer, ValidationError } = await import('../src/store.js');
const { ServerRuntime } = await import('../src/process-manager.js');
const { clearWipeData, nextMonthlyWipeAt } = await import('../src/wipe-scheduler.js');

function localTimestamp(year, month, day, hour, minute) {
  return new Date(year, month, day, hour, minute, 0, 0).getTime();
}

test('runtime expõe a próxima ocorrência e cancela o timer ao ser descartado', () => {
  const server = normalizeServer({
    identity: 'wipe_runtime',
    installDir: path.join(dataDir, 'rustds'),
    wipeSchedule: { enabled: true, dayOfMonth: 15, time: '04:30' },
  });
  const runtime = new ServerRuntime(server);
  assert.ok(runtime.status().nextWipeAt > Date.now());
  runtime.dispose();

  const disabled = new ServerRuntime(normalizeServer({
    identity: 'wipe_disabled',
    installDir: path.join(dataDir, 'rustds'),
  }));
  assert.equal(disabled.status().nextWipeAt, null);
  disabled.dispose();
});

test('wipe mensal escolhe a próxima ocorrência no horário local', () => {
  const schedule = { dayOfMonth: 15, time: '04:30' };
  assert.equal(nextMonthlyWipeAt(schedule, localTimestamp(2026, 0, 15, 4, 29)), localTimestamp(2026, 0, 15, 4, 30));
  assert.equal(nextMonthlyWipeAt(schedule, localTimestamp(2026, 0, 15, 4, 30)), localTimestamp(2026, 1, 15, 4, 30));
});

test('wipe de mapa remove apenas os arquivos do save e preserva blueprints/configuração', () => {
  const installDir = path.join(dataDir, 'rustds');
  const identityDir = path.join(installDir, 'server', 'wipe_map');
  fs.mkdirSync(path.join(identityDir, 'save', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(identityDir, 'save', 'world.sav'), 'world');
  fs.writeFileSync(path.join(identityDir, 'save', 'nested', 'world.1'), 'world chunk');
  fs.writeFileSync(path.join(identityDir, 'player.blueprints.5.db'), 'blueprints');
  fs.mkdirSync(path.join(identityDir, 'cfg'), { recursive: true });
  fs.writeFileSync(path.join(identityDir, 'cfg', 'server.cfg'), 'settings');

  const removed = clearWipeData({ installDir, identity: 'wipe_map' }, 'map');
  assert.equal(removed, 2);
  assert.deepEqual(fs.readdirSync(path.join(identityDir, 'save')), []);
  assert.equal(fs.readFileSync(path.join(identityDir, 'player.blueprints.5.db'), 'utf8'), 'blueprints');
  assert.equal(fs.readFileSync(path.join(identityDir, 'cfg', 'server.cfg'), 'utf8'), 'settings');
});

test('wipe de blueprints remove o banco e arquivos auxiliares, sem tocar no mapa', () => {
  const installDir = path.join(dataDir, 'rustds');
  const identityDir = path.join(installDir, 'server', 'wipe_bp');
  fs.mkdirSync(path.join(identityDir, 'save'), { recursive: true });
  fs.writeFileSync(path.join(identityDir, 'save', 'world.sav'), 'world');
  fs.writeFileSync(path.join(identityDir, 'player.blueprints.5.db'), 'blueprints');
  fs.writeFileSync(path.join(identityDir, 'player.blueprints.5.db-wal'), 'wal');
  fs.writeFileSync(path.join(identityDir, 'player.states.5.db'), 'states');

  const removed = clearWipeData({ installDir, identity: 'wipe_bp' }, 'blueprints');
  assert.equal(removed, 2);
  assert.equal(fs.readFileSync(path.join(identityDir, 'save', 'world.sav'), 'utf8'), 'world');
  assert.equal(fs.existsSync(path.join(identityDir, 'player.blueprints.5.db')), false);
  assert.equal(fs.existsSync(path.join(identityDir, 'player.blueprints.5.db-wal')), false);
  assert.equal(fs.existsSync(path.join(identityDir, 'player.states.5.db')), true);
});

test('configuração valida o wipe agendado e bloqueia combinações inválidas', () => {
  const server = normalizeServer({
    identity: 'wipe_config',
    installDir: path.join(dataDir, 'rustds'),
    wipeSchedule: { enabled: true, dayOfMonth: 28, time: '23:59', type: 'full', rotateSeed: true },
  });
  assert.deepEqual(server.wipeSchedule, {
    enabled: true,
    dayOfMonth: 28,
    time: '23:59',
    type: 'full',
    rotateSeed: true,
  });

  assert.throws(
    () => normalizeServer({ identity: 'wipe_remote', mode: 'remote', wipeSchedule: { enabled: true } }),
    /apenas para servidores locais/,
  );
  assert.throws(
    () => normalizeServer({ identity: 'wipe_day', installDir: dataDir, wipeSchedule: { dayOfMonth: 29 } }),
    ValidationError,
  );
  assert.throws(
    () => normalizeServer({ identity: 'wipe_time', installDir: dataDir, wipeSchedule: { time: '24:00' } }),
    ValidationError,
  );
  assert.throws(
    () => normalizeServer({ identity: 'wipe_seed', installDir: dataDir, wipeSchedule: { type: 'blueprints', rotateSeed: true } }),
    ValidationError,
  );
});

test('wipe rejeita identidade inválida antes de tocar no disco', () => {
  assert.throws(() => clearWipeData({ installDir: dataDir, identity: '../outside' }, 'full'), /Identidade inválida/);
  assert.throws(() => clearWipeData({ installDir: dataDir, identity: 'safe' }, 'unknown'), /Tipo de wipe inválido/);
});
