import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-backup-'));
process.env.RMC_DATA_DIR = dataDir;

const { normalizeServer, ValidationError } = await import('../src/store.js');
const { ServerRuntime } = await import('../src/process-manager.js');
const { nextDailyBackupAt, pruneScheduledBackups } = await import('../src/backup-scheduler.js');
const { serverBackupsDir } = await import('../src/paths.js');

function localTimestamp(year, month, day, hour, minute) {
  return new Date(year, month, day, hour, minute, 0, 0).getTime();
}

test('backup diário escolhe a próxima ocorrência no horário local', () => {
  const schedule = { time: '03:30' };
  assert.equal(nextDailyBackupAt(schedule, localTimestamp(2026, 10, 20, 3, 29)), localTimestamp(2026, 10, 20, 3, 30));
  assert.equal(nextDailyBackupAt(schedule, localTimestamp(2026, 10, 20, 3, 30)), localTimestamp(2026, 10, 21, 3, 30));
  assert.equal(nextDailyBackupAt(schedule, localTimestamp(2026, 10, 20, 22, 0)), localTimestamp(2026, 10, 21, 3, 30));
});

test('runtime expõe a próxima ocorrência e cancela o timer ao ser descartado', () => {
  const server = normalizeServer({
    identity: 'backup_runtime',
    installDir: path.join(dataDir, 'rustds'),
    backupSchedule: { enabled: true, time: '03:30', keep: 7 },
  });
  const runtime = new ServerRuntime(server);
  assert.ok(runtime.status().nextBackupAt > Date.now());
  runtime.dispose();

  const disabled = new ServerRuntime(normalizeServer({
    identity: 'backup_disabled',
    installDir: path.join(dataDir, 'rustds'),
  }));
  assert.equal(disabled.status().nextBackupAt, null);
  disabled.dispose();
});

test('configuração valida o backup automático e bloqueia servidores remotos', () => {
  const server = normalizeServer({
    identity: 'backup_config',
    installDir: path.join(dataDir, 'rustds'),
    backupSchedule: { enabled: true, time: '05:00', keep: 3 },
  });
  assert.deepEqual(server.backupSchedule, { enabled: true, time: '05:00', keep: 3 });

  assert.throws(
    () => normalizeServer({ identity: 'backup_bad', installDir: path.join(dataDir, 'rustds'), backupSchedule: { time: '24:00' } }),
    ValidationError,
  );
  assert.throws(
    () => normalizeServer({ identity: 'backup_big', installDir: path.join(dataDir, 'rustds'), backupSchedule: { keep: 53 } }),
    ValidationError,
  );
  assert.throws(
    () => normalizeServer({ identity: 'backup_remote', mode: 'remote', host: '10.0.0.5', backupSchedule: { enabled: true } }),
    ValidationError,
  );
});

test('retenção mantém os agendados mais recentes e nunca apaga manuais nem do wipe', () => {
  const server = normalizeServer({ identity: 'backup_prune', installDir: path.join(dataDir, 'rustds') });
  const dir = serverBackupsDir(server.id);
  const day = (n) => new Date(2026, 9, n, 3, 0, 0, 0).getTime();
  const files = [
    ['2026-10-01T03-00-00-scheduled.tar.gz', day(1)],
    ['2026-10-02T03-00-00-scheduled.tar.gz', day(2)],
    ['2026-10-03T03-00-00-scheduled.tar.gz', day(3)],
    ['2026-10-04T03-00-00-scheduled.tar.gz', day(4)],
    ['2026-10-03T12-00-00-manual.tar.gz', day(3)],
    ['2026-10-01T00-00-00-scheduled-wipe.tar.gz', day(1)],
    ['2026-10-02T00-00-00-pre-restore.tar.gz', day(2)],
  ];
  for (const [name, mtime] of files) {
    fs.writeFileSync(path.join(dir, name), 'x');
    fs.utimesSync(path.join(dir, name), new Date(mtime), new Date(mtime));
  }

  const removed = pruneScheduledBackups(server, 2);
  assert.deepEqual(removed, [
    '2026-10-02T03-00-00-scheduled.tar.gz',
    '2026-10-01T03-00-00-scheduled.tar.gz',
  ]);
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    [
      '2026-10-03T03-00-00-scheduled.tar.gz',
      '2026-10-04T03-00-00-scheduled.tar.gz',
      '2026-10-03T12-00-00-manual.tar.gz',
      '2026-10-01T00-00-00-scheduled-wipe.tar.gz',
      '2026-10-02T00-00-00-pre-restore.tar.gz',
    ].sort(),
  );

  assert.deepEqual(pruneScheduledBackups(server, 5), []);
});
