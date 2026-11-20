import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-discover-'));
process.env.RMC_DATA_DIR = dataDir;

const { scanInstall } = await import('../src/discover.js');
const { ValidationError } = await import('../src/store.js');

function makeInstall(root, identities) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'RustDedicated.exe'), '');
  for (const [identity, cfg] of Object.entries(identities)) {
    const dir = path.join(root, 'server', identity, 'cfg');
    fs.mkdirSync(dir, { recursive: true });
    if (cfg) fs.writeFileSync(path.join(dir, 'server.cfg'), cfg, 'utf8');
  }
}

test('encontra executável e identidades com valores do server.cfg', () => {
  const root = path.join(dataDir, 'rustds');
  makeInstall(root, {
    my_server: 'server.hostname "Kanemaki"\nserver.port 28015\nrcon.port 28016\nrcon.password "segredo_1"\n',
    outro: '',
  });
  fs.mkdirSync(path.join(root, 'server', 'my_server', 'save'), { recursive: true });

  const scan = scanInstall(root);
  assert.equal(scan.installed, true);
  assert.equal(scan.executable, 'RustDedicated.exe');
  assert.equal(scan.identities.length, 2);

  const mine = scan.identities.find((item) => item.identity === 'my_server');
  assert.equal(mine.hasSave, true);
  assert.equal(mine.hasConfig, true);
  assert.equal(mine.values['server.hostname'], 'Kanemaki');
  assert.equal(mine.values['server.port'], 28015);
  assert.equal(mine.values['rcon.port'], 28016);
  assert.equal(mine.values['rcon.password'], 'segredo_1');

  const outro = scan.identities.find((item) => item.identity === 'outro');
  assert.equal(outro.hasConfig, false);
  assert.equal(outro.hasSave, false);
});

test('ignora pastas que não são identidades válidas', () => {
  const root = path.join(dataDir, 'rustds2');
  makeInstall(root, { valida: '' });
  fs.mkdirSync(path.join(root, 'server', 'pasta com espaço'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server', 'arquivo.txt'), '');

  const scan = scanInstall(root);
  assert.deepEqual(
    scan.identities.map((item) => item.identity),
    ['valida'],
  );
});

test('pasta inexistente e caminho vazio são rejeitados', () => {
  assert.throws(() => scanInstall(path.join(dataDir, 'nao-existe')), ValidationError);
  assert.throws(() => scanInstall(''), ValidationError);
});

test('instalação sem executável é reportada como não instalada', () => {
  const root = path.join(dataDir, 'sem-exe');
  fs.mkdirSync(path.join(root, 'server', 'x'), { recursive: true });
  const scan = scanInstall(root);
  assert.equal(scan.installed, false);
  assert.equal(scan.executable, null);
});
