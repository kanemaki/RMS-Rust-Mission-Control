import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-oxide-'));
process.env.RMC_DATA_DIR = dataDir;

const { ValidationError } = await import('../src/errors.js');
const {
  isUmodUrl,
  pickOxideAsset,
  installPluginFromUmod,
  parsePluginHeader,
  savePluginContent,
  listPlugins,
  deletePlugin,
  readPluginConfig,
  writePluginConfig,
  oxideStatus,
} = await import('../src/oxide.js');

const PLUGIN_CS = `using Oxide.Core.Plugins;

namespace Oxide.Plugins
{
    [Info("Emergency Button", "nivex", "1.0.6")]
    [Description("Adds a command to toggle the emergency button")]
    public class EmergencyButton : RustPlugin
    {
    }
}`;

test('parsePluginHeader lê título, autor e versão entre aspas ou sem aspas', () => {
  const header = parsePluginHeader(PLUGIN_CS);
  assert.deepEqual(header, {
    title: 'Emergency Button',
    author: 'nivex',
    version: '1.0.6',
    description: 'Adds a command to toggle the emergency button',
  });
  const unquoted = parsePluginHeader('[Info("Zones Manager", "k1lly0u", 3.0.51)]');
  assert.equal(unquoted.version, '3.0.51');
  assert.equal(parsePluginHeader('sem cabeçalho'), null);
});

test('savePluginContent grava, listPlugins lê o cabeçalho e deletePlugin remove', () => {
  const server = { installDir: path.join(dataDir, 'oxide_files') };
  const saved = savePluginContent(server, 'EmergencyButton', PLUGIN_CS);
  assert.equal(saved.name, 'EmergencyButton');
  assert.equal(saved.title, 'Emergency Button');

  const plugins = listPlugins(server);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].name, 'EmergencyButton');
  assert.equal(plugins[0].title, 'Emergency Button');
  assert.equal(plugins[0].author, 'nivex');
  assert.equal(plugins[0].version, '1.0.6');
  assert.equal(plugins[0].hasConfig, false);
  assert.ok(plugins[0].updatedAt > 0);

  // Pasta Oxide/config com um JSON marca hasConfig.
  fs.mkdirSync(path.join(server.installDir, 'Oxide', 'config'), { recursive: true });
  fs.writeFileSync(path.join(server.installDir, 'Oxide', 'config', 'EmergencyButton.json'), '{}');
  assert.equal(listPlugins(server)[0].hasConfig, true);

  deletePlugin(server, 'EmergencyButton');
  assert.equal(listPlugins(server).length, 0);
  assert.throws(() => deletePlugin(server, 'EmergencyButton'), ValidationError);
});

test('nome de plugin bloqueia travessia de caminho e caracteres estranhos', () => {
  const server = { installDir: path.join(dataDir, 'oxide_files') };
  assert.throws(() => savePluginContent(server, '../evil', PLUGIN_CS), ValidationError);
  assert.throws(() => savePluginContent(server, 'sub/ dir', PLUGIN_CS), ValidationError);
  assert.throws(() => savePluginContent(server, '', PLUGIN_CS), ValidationError);
  assert.throws(() => readPluginConfig(server, '..'), ValidationError);
  assert.throws(() => deletePlugin(server, 'a;b'), ValidationError);
});

test('config de plugin valida JSON e preserva o conteúdo gravado', () => {
  const server = { installDir: path.join(dataDir, 'oxide_cfg') };
  const missing = readPluginConfig(server, 'EmergencyButton');
  assert.equal(missing.exists, false);
  assert.equal(missing.raw, '');

  assert.throws(() => writePluginConfig(server, 'EmergencyButton', '{ quebrado'), ValidationError);
  assert.throws(() => writePluginConfig(server, 'EmergencyButton', undefined), ValidationError);

  const written = writePluginConfig(
    server,
    'EmergencyButton',
    JSON.stringify({ Settings: { 'Enable button': true }, Version: '1.0.6' }),
  );
  assert.equal(written.exists, true);
  const parsed = JSON.parse(written.raw);
  assert.equal(parsed.Version, '1.0.6');

  const reread = readPluginConfig(server, 'EmergencyButton');
  assert.equal(reread.exists, true);
  assert.equal(JSON.parse(reread.raw).Settings['Enable button'], true);
});

test('isUmodUrl e installPluginFromUmod rejeitam endereços fora do uMod sem rede', async () => {
  assert.ok(isUmodUrl('https://umod.org/plugins/EmergencyButton.cs'));
  assert.ok(!isUmodUrl('http://umod.org/plugins/EmergencyButton.cs')); // sem https
  assert.ok(!isUmodUrl('https://evil.com/plugins/EmergencyButton.cs'));
  assert.ok(!isUmodUrl('https://umod.org/plugins/x/../evil.cs'));
  assert.ok(!isUmodUrl(''));
  await assert.rejects(() => installPluginFromUmod({ installDir: dataDir }, 'https://evil.com/plugins/X.cs'), ValidationError);
});

test('pickOxideAsset aceita o nome novo da release e o legado, escolhendo por plataforma', () => {
  const current = [
    { name: 'Oxide.Rust-linux.zip', size: 1 },
    { name: 'Oxide.Rust.zip', size: 2 },
  ];
  // No Windows vem o zip sem -linux; no Linux, o -linux.
  assert.equal(pickOxideAsset(current, 'win32').name, 'Oxide.Rust.zip');
  assert.equal(pickOxideAsset(current, 'linux').name, 'Oxide.Rust-linux.zip');
  // Releases antigas: um único Oxide-Rust.zip serve para qualquer plataforma.
  const legacy = [{ name: 'Oxide-Rust.zip', size: 3 }];
  assert.equal(pickOxideAsset(legacy, 'win32').name, 'Oxide-Rust.zip');
  assert.equal(pickOxideAsset(legacy, 'linux').name, 'Oxide-Rust.zip');
  // Formato desconhecido (uMod renomeou de novo) devolve null.
  assert.equal(pickOxideAsset([{ name: 'Oxide-Rust.exe' }], 'win32'), null);
  assert.equal(pickOxideAsset([], 'win32'), null);
  assert.equal(pickOxideAsset(undefined, 'win32'), null);
});

test('oxideStatus informa instalação pela DLL em RustDedicated_Data/Managed', () => {
  const server = { installDir: path.join(dataDir, 'status_srv') };
  assert.deepEqual(oxideStatus(server), { installed: false, pluginCount: 0, pluginsDir: path.join(server.installDir, 'Oxide', 'plugins') });

  fs.mkdirSync(path.join(server.installDir, 'RustDedicated_Data', 'Managed'), { recursive: true });
  fs.writeFileSync(path.join(server.installDir, 'RustDedicated_Data', 'Managed', 'Oxide.Core.dll'), 'dll');
  const status = oxideStatus(server);
  assert.equal(status.installed, true);
  assert.equal(status.pluginCount, 0);
});

test('rotas /oxide servem plugins e configs; ações exigem runtime', async () => {
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
      body: JSON.stringify({ password: 'senha-oxide-forte' }),
    });
    const cookie = (setupRes.headers.get('set-cookie') ?? '').split(';')[0];
    assert.ok(cookie, 'sessão não recebida no setup');

    const createRes = await fetch(`${base}/api/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-rmc-request': '1' },
      body: JSON.stringify({ identity: 'oxide_srv', installDir: path.join(dataDir, 'oxide_rustds') }),
    });
    assert.equal(createRes.status, 201, `falha ao criar servidor: ${await createRes.text()}`);

    const status = await fetch(`${base}/api/servers/oxide_srv/oxide`, { headers: { cookie } });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      installed: false,
      pluginCount: 0,
      pluginsDir: path.join(dataDir, 'oxide_rustds', 'Oxide', 'plugins'),
    });

    const upload = await fetch(`${base}/api/servers/oxide_srv/oxide/plugins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-rmc-request': '1' },
      body: JSON.stringify({ name: 'EmergencyButton', content: PLUGIN_CS }),
    });
    assert.equal(upload.status, 201, `falha no upload: ${await upload.text()}`);

    const badUrl = await fetch(`${base}/api/servers/oxide_srv/oxide/plugins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-rmc-request': '1' },
      body: JSON.stringify({ url: 'https://evil.com/plugins/X.cs' }),
    });
    assert.equal(badUrl.status, 400);

    const empty = await fetch(`${base}/api/servers/oxide_srv/oxide/plugins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-rmc-request': '1' },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);

    const list = await fetch(`${base}/api/servers/oxide_srv/oxide/plugins`, { headers: { cookie } });
    const plugins = await list.json();
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].name, 'EmergencyButton');
    assert.equal(plugins[0].loaded, false);

    const cfgWrite = await fetch(`${base}/api/servers/oxide_srv/oxide/plugins/EmergencyButton/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie, 'x-rmc-request': '1' },
      body: JSON.stringify({ raw: '{"Enabled":true}' }),
    });
    assert.equal(cfgWrite.status, 200);
    const cfgRead = await fetch(`${base}/api/servers/oxide_srv/oxide/plugins/EmergencyButton/config`, { headers: { cookie } });
    const cfg = await cfgRead.json();
    assert.equal(cfg.exists, true);
    assert.equal(JSON.parse(cfg.raw).Enabled, true);

    const badCfg = await fetch(`${base}/api/servers/oxide_srv/oxide/plugins/EmergencyButton/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie, 'x-rmc-request': '1' },
      body: JSON.stringify({ raw: 'nope' }),
    });
    assert.equal(badCfg.status, 400);

    // Servidor cadastrado mas sem RCON conectado → 409 (ConflictError), não travar.
    const action = await fetch(`${base}/api/servers/oxide_srv/oxide/plugins/EmergencyButton/reload`, {
      method: 'POST',
      headers: { cookie, 'x-rmc-request': '1' },
    });
    assert.equal(action.status, 409);

    // Ação fora da lista conhecida → 404.
    const badAction = await fetch(`${base}/api/servers/oxide_srv/oxide/plugins/EmergencyButton/start`, {
      method: 'POST',
      headers: { cookie, 'x-rmc-request': '1' },
    });
    assert.equal(badAction.status, 404);

    const remove = await fetch(`${base}/api/servers/oxide_srv/oxide/plugins/EmergencyButton`, {
      method: 'DELETE',
      headers: { cookie, 'x-rmc-request': '1' },
    });
    assert.equal(remove.status, 200);
    const after = await fetch(`${base}/api/servers/oxide_srv/oxide/plugins`, { headers: { cookie } });
    assert.deepEqual(await after.json(), []);
  } finally {
    httpServer.close();
  }
});
