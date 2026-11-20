// E2E efêmero: sobe o agente em porta própria com RMC_DATA_DIR temporário,
// cria um servidor com estrutura fake de Oxide e semeia plugins/configs.
// Uso: RMC_DATA_DIR=... node e2e-oxide.cjs  (Ctrl+C encerra)
const fs = require('node:fs');
const path = require('node:path');

const dataDir = process.env.RMC_DATA_DIR;
if (!dataDir || !fs.existsSync(dataDir)) {
  console.error('Defina RMC_DATA_DIR para um diretório temporário.');
  process.exit(1);
}
const installDir = path.join(dataDir, 'rustds');
const pluginsDir = path.join(installDir, 'Oxide', 'plugins');
const configDir = path.join(installDir, 'Oxide', 'config');
const managedDir = path.join(installDir, 'RustDedicated_Data', 'Managed');
for (const dir of [pluginsDir, configDir, managedDir]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(managedDir, 'Oxide.Core.dll'), 'fake-dll');
fs.writeFileSync(
  path.join(pluginsDir, 'EmergencyButton.cs'),
  `using Oxide.Core.Plugins;\nnamespace Oxide.Plugins {\n  [Info("Emergency Button", "nivex", "1.0.6")]\n  [Description("Adds a command to toggle the emergency button")]\n  public class EmergencyButton : RustPlugin {}\n}\n`,
);
fs.writeFileSync(
  path.join(pluginsDir, 'ZoneManager.cs'),
  `using Oxide.Core.Plugins;\nnamespace Oxide.Plugins {\n  [Info("Zone Manager", "k1lly0u", 3.0.51)]\n  public class ZoneManager : RustPlugin {}\n}\n`,
);
fs.writeFileSync(
  path.join(configDir, 'EmergencyButton.json'),
  JSON.stringify({ Settings: { 'Enable button': true }, Version: '1.0.6' }, null, 2),
);

const base = 'http://127.0.0.1:3939';
async function api(method, url, body, cookie) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(body ? { 'x-rmc-request': '1' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

async function main() {
  const { createApi } = await import('./src/api.js');
  const { default: express } = await import('express');
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', createApi({ secureCookies: false }));
  app.use(express.static(path.join(__dirname, 'public')));
  const httpServer = app.listen(3939, '127.0.0.1');
  await new Promise((resolve) => httpServer.once('listening', resolve));
  console.log('AGENTE-EFEMERO no ar em http://127.0.0.1:3939');

  const needsSetup = (await api('GET', '/api/setup')).text.includes('"needsSetup":true');
  const setup = await api('POST', '/api/setup', { password: 'demo-oxide-2026' });
  const cookie = setup.cookie;
  console.log('setup:', setup.status, needsSetup ? '(novo)' : '(já existia)');
  if (!cookie) throw new Error('sem cookie de sessão');

  const created = await api('POST', '/api/servers', { identity: 'oxide_demo', installDir }, cookie);
  console.log('criar servidor:', created.status);

  const status = await api('GET', '/api/servers/oxide_demo/oxide', null, cookie);
  console.log('status oxide:', status.status, status.text);
  const plugins = await api('GET', '/api/servers/oxide_demo/oxide/plugins', null, cookie);
  console.log('plugins:', plugins.status, plugins.text);
  const cfg = await api('GET', '/api/servers/oxide_demo/oxide/plugins/EmergencyButton/config', null, cookie);
  console.log('config lida:', cfg.status, cfg.exists !== undefined ? 'ok' : cfg.text);

  const keepAlive = setInterval(() => {}, 1 << 30);
  process.on('SIGINT', () => {
    clearInterval(keepAlive);
    httpServer.close(() => process.exit(0));
  });
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
