import express from 'express';
import {
  addGroup,
  addServer,
  detectInstall,
  findServer,
  listGroups,
  loadConfig,
  publicServer,
  removeGroup,
  removeServer,
  updateGroup,
  updateServer,
  normalizeChatFilter,
  ValidationError,
} from './store.js';
import { runtimeManager } from './process-manager.js';
import { ConflictError } from './errors.js';
import { logBus } from './logbus.js';
import { closeSessions, getPlayer, listModeration, listPlayers, normalizeSteamId, setPlayerNote } from './players.js';
import { listChat } from './chat.js';
import { readConfig, writeConfig, launchPatch, validateValues, withoutSecrets } from './cfg.js';
import { createBackup, deleteBackup, listBackups, restoreBackup } from './backups.js';
import { audit, listAudit, listSamples, listSamplesRange } from './db.js';
import { applyLicense, assertServerLimit, licenseStatus, removeLicense } from './license.js';
import { sendDiscord } from './discord.js';
import { scanInstall } from './discover.js';
import {
  deletePlugin,
  detectLoadedPlugins,
  installOrUpdateOxide,
  installPluginFromUmod,
  isOxideInstalled,
  listPlugins,
  oxideStatus,
  readPluginConfig,
  savePluginContent,
  writePluginConfig,
} from './oxide.js';

const SAMPLE_RANGES = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };
const MAX_POINTS = 400;
const BATCH_ACTIONS = ['start', 'stop', 'restart', 'backup'];
import {
  beginTotpSetup,
  clearCookie,
  confirmTotpSetup,
  createPendingChallenge,
  createSession,
  destroyPendingChallenge,
  destroySession,
  disableTotp,
  loginRateLimit,
  needsSetup,
  readPendingChallenge,
  requireAuth,
  resetLoginAttempts,
  resetTotpAttempts,
  sessionCookie,
  setPassword,
  tokenFromRequest,
  totpEnabled,
  totpRateLimit,
  verifyPassword,
  verifySecondFactor,
} from './auth.js';
import QRCode from 'qrcode';

export function createApi({ secureCookies = false, version = '0.1.0' } = {}) {
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.json({ ok: true, version, uptimeMs: Math.round(process.uptime() * 1000) });
  });

  router.get('/setup', (req, res) => {
    res.json({ needsSetup: needsSetup() });
  });

  router.post('/setup', (req, res) => {
    if (!needsSetup()) {
      res.status(409).json({ error: 'O painel já está configurado.' });
      return;
    }
    setPassword(req.body?.password);
    const { token } = createSession({ ip: req.ip, userAgent: req.get('user-agent') });
    res.setHeader('Set-Cookie', sessionCookie(token, { secure: secureCookies }));
    audit('setup', { ip: req.ip });
    res.json({ ok: true });
  });

  router.post('/auth/login', loginRateLimit, (req, res) => {
    if (!verifyPassword(req.body?.password)) {
      audit('login_failed', { ip: req.ip });
      res.status(401).json({ error: 'Senha incorreta.' });
      return;
    }
    resetLoginAttempts(req.ip);
    if (totpEnabled()) {
      const challenge = createPendingChallenge({ ip: req.ip, userAgent: req.get('user-agent') });
      audit('login_totp_challenge', { ip: req.ip });
      res.json({ ok: true, totpRequired: true, challenge: challenge.token, expiresAt: challenge.expiresAt });
      return;
    }
    const { token } = createSession({ ip: req.ip, userAgent: req.get('user-agent') });
    res.setHeader('Set-Cookie', sessionCookie(token, { secure: secureCookies }));
    audit('login', { ip: req.ip });
    res.json({ ok: true });
  });

  router.post('/auth/login/totp', totpRateLimit, (req, res) => {
    const challenge = String(req.body?.challenge ?? '');
    if (!readPendingChallenge(challenge)) {
      res.status(401).json({ error: 'Desafio expirado. Entre novamente com a senha.' });
      return;
    }
    const result = verifySecondFactor(req.body?.code);
    if (!result.ok) {
      audit('totp_failed', { ip: req.ip });
      res.status(401).json({ error: 'Código inválido.' });
      return;
    }
    destroyPendingChallenge(challenge);
    resetTotpAttempts(req.ip);
    const { token } = createSession({ ip: req.ip, userAgent: req.get('user-agent') });
    res.setHeader('Set-Cookie', sessionCookie(token, { secure: secureCookies }));
    audit(result.recovery ? 'login_recovery_code' : 'login_totp', { ip: req.ip });
    res.json({ ok: true, recovery: result.recovery });
  });

  router.post('/auth/logout', (req, res) => {
    destroySession(tokenFromRequest(req));
    res.setHeader('Set-Cookie', clearCookie());
    res.json({ ok: true });
  });

  router.get('/auth/me', requireAuth, (req, res) => {
    res.json({ authenticated: true, expiresAt: req.session.expiresAt, totpEnabled: totpEnabled() });
  });

  router.use(requireAuth);

  // Licença offline: o painel lê o estado e aceita o JSON assinado colado pelo
  // cliente. Nada aqui faz chamada de rede.
  router.get('/license', (req, res) => {
    res.json(licenseStatus());
  });

  router.post('/license', (req, res) => {
    try {
      const status = applyLicense(req.body?.text);
      audit('license_applied', { detail: status.licenseId ?? status.state, ip: req.ip });
      res.json(status);
    } catch (err) {
      audit('license_rejected', { detail: err.message, ip: req.ip });
      throw err;
    }
  });

  router.delete('/license', (req, res) => {
    const removed = removeLicense();
    audit('license_removed', { detail: removed ? 'removed' : 'absent', ip: req.ip });
    res.json({ ok: true, removed, license: licenseStatus() });
  });

  // Modo somente leitura: licença expirada/inválida mantém servidores, console,
  // backups e restore funcionando, mas bloqueia mudanças de configuração.
  const requireWritable = (req, res, next) => {
    const status = licenseStatus();
    if (!status.readOnly) {
      next();
      return;
    }
    res.status(403).json({
      error: status.error ?? 'Licença expirada ou inválida: o painel está em modo somente leitura.',
      license: status,
    });
  };

  router.get('/auth/totp', (req, res) => {
    const { totp } = loadConfig().auth;
    res.json({
      enabled: Boolean(totp?.enabled),
      enabledAt: totp?.enabledAt ?? null,
      recoveryCodesLeft: Array.isArray(totp?.recoveryCodes) ? totp.recoveryCodes.length : 0,
    });
  });

  router.post('/auth/totp/setup', async (req, res) => {
    const { secret, otpauth } = beginTotpSetup({ account: 'painel' });
    const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 240 });
    audit('totp_setup_start', { ip: req.ip });
    res.json({ secret, otpauth, qr });
  });

  router.post('/auth/totp/enable', (req, res) => {
    const { recoveryCodes } = confirmTotpSetup(req.body?.code);
    audit('totp_enabled', { ip: req.ip });
    res.json({ ok: true, recoveryCodes });
  });

  router.post('/auth/totp/disable', (req, res) => {
    disableTotp({ password: req.body?.password, code: req.body?.code });
    audit('totp_disabled', { ip: req.ip });
    res.json({ ok: true });
  });

  const localOnly = (req, res, next) => {
    const server = findServer(req.params.id);
    if (server?.mode === 'remote') {
      res.status(409).json({ error: 'Recurso disponível apenas para servidores locais.' });
      return;
    }
    next();
  };
  router.use(['/servers/:id/config', '/servers/:id/backups', '/servers/:id/oxide'], localOnly);

  router.get('/discover', (req, res) => {
    res.json({ defaultInstallDir: detectInstall()?.installDir ?? '' });
  });

  router.post('/discover', (req, res) => {
    const scan = scanInstall(req.body?.installDir);
    audit('discover_scan', { detail: scan.installDir, ip: req.ip });
    res.json(scan);
  });

  router.get('/groups', (req, res) => {
    res.json(listGroups());
  });

  router.post('/groups', requireWritable, (req, res) => {
    const group = addGroup(req.body ?? {});
    audit('group_create', { detail: group.name, ip: req.ip });
    res.status(201).json(group);
  });

  router.patch('/groups/:id', requireWritable, (req, res) => {
    const group = updateGroup(req.params.id, req.body ?? {});
    if (!group) {
      res.status(404).json({ error: 'Grupo não encontrado.' });
      return;
    }
    audit('group_update', { detail: group.name, ip: req.ip });
    res.json(group);
  });

  router.delete('/groups/:id', requireWritable, (req, res) => {
    if (!removeGroup(req.params.id)) {
      res.status(404).json({ error: 'Grupo não encontrado.' });
      return;
    }
    runtimeManager.sync(loadConfig().servers);
    audit('group_delete', { detail: req.params.id, ip: req.ip });
    res.json({ ok: true });
  });

  router.get('/servers', (req, res) => {
    const config = loadConfig();
    res.json(
      config.servers.map((server) => ({
        ...publicServer(server),
        status: runtimeManager.get(server.id)?.status() ?? null,
      })),
    );
  });

  router.post('/servers', requireWritable, (req, res) => {
    assertServerLimit(loadConfig().servers.length);
    const server = addServer(req.body ?? {});
    runtimeManager.sync(loadConfig().servers);
    audit('server_create', { serverId: server.id, detail: server.name, ip: req.ip });
    res.status(201).json({ ...publicServer(server), status: runtimeManager.get(server.id)?.status() ?? null });
  });

  router.get('/servers/:id', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    res.json({ ...publicServer(server), status: runtimeManager.get(server.id)?.status() ?? null });
  });

  router.patch('/servers/:id', requireWritable, (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    if (runtimeManager.get(server.id)?.wipeInProgress) {
      throw new ConflictError('Não é possível alterar o servidor durante um wipe agendado.');
    }
    const updated = updateServer(server.id, req.body ?? {});
    runtimeManager.sync(loadConfig().servers);
    audit('server_update', { serverId: server.id, ip: req.ip });
    res.json({ ...publicServer(updated), status: runtimeManager.get(updated.id)?.status() ?? null });
  });

  router.delete('/servers/:id', requireWritable, async (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const runtime = runtimeManager.get(server.id);
    if (runtime) {
      await runtime.stop();
      runtime.dispose();
    }
    removeServer(server.id);
    runtimeManager.sync(loadConfig().servers);
    audit('server_delete', { serverId: server.id, ip: req.ip });
    res.json({ ok: true });
  });

  // Ação em lote sobre vários servidores de uma vez. Cada servidor roda isolado:
  // o resultado é agregado por item em vez de a primeira falha derrubar o lote.
  // O lote nunca roda atualização automática — SteamCMD concorrente na mesma
  // pasta trava; para atualizar, use a ação individual de cada servidor.
  router.post('/servers/batch', async (req, res) => {
    const rawIds = req.body?.ids;
    const action = String(req.body?.action ?? '');
    if (!Array.isArray(rawIds) || !rawIds.length) {
      throw new ValidationError('ids deve ser uma lista de servidores.');
    }
    const ids = [...new Set(rawIds.map((id) => String(id ?? '').trim()).filter(Boolean))];
    if (!ids.length) throw new ValidationError('ids deve ser uma lista de servidores.');
    if (ids.length > 50) throw new ValidationError('O lote aceita no máximo 50 servidores.');
    if (!BATCH_ACTIONS.includes(action)) {
      throw new ValidationError('Ação inválida. Use start, stop, restart ou backup.');
    }

    const config = loadConfig();
    const targets = ids.map((id) => ({ id, server: config.servers.find((item) => item.id === id) ?? null }));
    const outcomes = await Promise.allSettled(
      targets.map(async ({ id, server }) => {
        if (!server) throw new ValidationError('Servidor não encontrado.');
        if (action === 'backup') {
          if (server.mode === 'remote') {
            throw new ValidationError('Backup disponível apenas para servidores locais.');
          }
          const runtime = runtimeManager.get(id);
          const backup = await createBackup(server, runtime, { label: 'batch' });
          return { backup, status: runtime?.status() ?? null };
        }
        const runtime = runtimeManager.get(id);
        if (!runtime) throw new ValidationError('Servidor não encontrado.');
        const options = { skipUpdate: true };
        const status =
          action === 'stop'
            ? await runtime.stop()
            : action === 'restart'
              ? await runtime.restart(options)
              : await runtime.start(options);
        return { status };
      }),
    );

    const results = targets.map(({ id, server }, index) => {
      const outcome = outcomes[index];
      const name = server?.name ?? id;
      if (outcome.status === 'rejected') {
        return { id, name, ok: false, error: outcome.reason?.message ?? 'Falha ao executar a ação.' };
      }
      return { id, name, ok: true, ...outcome.value };
    });
    const succeeded = results.filter((item) => item.ok).length;
    audit('server_batch', { detail: `${action}: ${succeeded}/${results.length}`, ip: req.ip });
    res.json({ ok: true, action, total: results.length, succeeded, failed: results.length - succeeded, results });
  });

  router.post('/servers/:id/start', async (req, res) => {
    const runtime = requireRuntime(req, res);
    if (!runtime) return;
    const status = await runtime.start({ skipUpdate: Boolean(req.body?.skipUpdate) });
    audit('server_start', { serverId: runtime.server.id, ip: req.ip });
    res.json(status);
  });

  router.post('/servers/:id/stop', async (req, res) => {
    const runtime = requireRuntime(req, res);
    if (!runtime) return;
    const status = await runtime.stop();
    audit('server_stop', { serverId: runtime.server.id, ip: req.ip });
    res.json(status);
  });

  router.post('/servers/:id/restart', async (req, res) => {
    const runtime = requireRuntime(req, res);
    if (!runtime) return;
    const status = await runtime.restart({ skipUpdate: Boolean(req.body?.skipUpdate) });
    audit('server_restart', { serverId: runtime.server.id, ip: req.ip });
    res.json(status);
  });

  router.post('/servers/:id/update', async (req, res) => {
    const runtime = requireRuntime(req, res);
    if (!runtime) return;
    const result = await runtime.update();
    audit('server_update_files', {
      serverId: runtime.server.id,
      detail: result.ok ? 'ok' : result.error ?? `código ${result.code}`,
      ip: req.ip,
    });
    res.json({ ...result, status: runtime.status() });
  });

  router.post('/servers/:id/command', async (req, res) => {
    const runtime = requireRuntime(req, res);
    if (!runtime) return;
    const command = String(req.body?.command ?? '').trim();
    if (!command) throw new ValidationError('Comando vazio.');
    if (command.length > 500 || /[\r\n]/.test(command)) throw new ValidationError('Comando inválido.');
    const response = await runtime.command(command);
    audit('rcon_command', { serverId: runtime.server.id, detail: command, ip: req.ip });
    res.json({ response });
  });

  router.post('/servers/:id/announce', async (req, res) => {
    const runtime = requireRuntime(req, res);
    if (!runtime) return;
    const message = req.body?.message === undefined ? null : req.body.message;
    const result = await runtime.announceNow(message);
    audit('server_announce', { serverId: runtime.server.id, detail: result.message, ip: req.ip });
    res.json(result);
  });

  router.get('/servers/:id/logs', (req, res) => {
    const runtime = requireRuntime(req, res);
    if (!runtime) return;
    res.json(logBus.history(runtime.server.id, Number(req.query.limit) || 300));
  });

  router.get('/servers/:id/players', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    reconcileSessions(server);
    res.json(listPlayers(server.id, { search: req.query.search, limit: req.query.limit }));
  });

  router.get('/servers/:id/players/:steamId', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    reconcileSessions(server);
    const steamId = normalizeSteamId(req.params.steamId);
    const player = getPlayer(server.id, steamId);
    if (!player) {
      res.status(404).json({ error: 'Jogador não encontrado.' });
      return;
    }
    res.json(player);
  });

  router.patch('/servers/:id/players/:steamId', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const steamId = normalizeSteamId(req.params.steamId);
    const result = setPlayerNote(server.id, steamId, req.body?.note);
    audit('player_note', { serverId: server.id, detail: steamId, ip: req.ip });
    res.json(result);
  });

  router.get('/servers/:id/moderation', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const steamId = req.query.steamId ? normalizeSteamId(req.query.steamId) : null;
    res.json(listModeration(server.id, { steamId, limit: req.query.limit }));
  });

  router.post('/servers/:id/players/:steamId/action', async (req, res) => {
    const runtime = requireRuntime(req, res);
    if (!runtime) return;
    const steamId = normalizeSteamId(req.params.steamId);
    const action = String(req.body?.action ?? '').trim().toLowerCase();
    const player = getPlayer(runtime.server.id, steamId);
    const name = player?.name ?? (String(req.body?.name ?? '').trim() || steamId);
    const result = await runtime.moderate({
      action,
      steamId,
      name,
      reason: req.body?.reason,
      minutes: req.body?.minutes,
      actor: 'panel',
    });
    let sync = null;
    if (action === 'ban' && req.body?.sync) {
      sync = await syncBan(runtime, {
        steamId,
        name,
        reason: req.body?.reason,
        minutes: req.body?.minutes,
      });
    }
    audit(`player_${action}`, {
      serverId: runtime.server.id,
      detail: `${name} (${steamId})${req.body?.reason ? `: ${req.body.reason}` : ''}`,
      ip: req.ip,
    });
    res.json({ ...result, sync });
  });

  router.get('/servers/:id/chat', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    res.json(listChat(server.id, { limit: req.query.limit, flagged: req.query.flagged === '1' }));
  });

  router.post('/servers/:id/chat', async (req, res) => {
    const runtime = requireRuntime(req, res);
    if (!runtime) return;
    const message = String(req.body?.message ?? '')
      .replace(/[\r\n]/g, ' ')
      .trim();
    if (!message) throw new ValidationError('Mensagem vazia.');
    if (message.length > 200) throw new ValidationError('A mensagem aceita no máximo 200 caracteres.');
    const response = await runtime.command(`say ${message}`);
    audit('chat_say', { serverId: runtime.server.id, detail: message, ip: req.ip });
    res.json({ response });
  });

  router.get('/servers/:id/chat-filter', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    res.json(server.chatFilter);
  });

  router.put('/servers/:id/chat-filter', requireWritable, (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const filter = normalizeChatFilter(req.body, server.chatFilter);
    const updated = updateServer(server.id, { chatFilter: filter });
    runtimeManager.sync(loadConfig().servers);
    audit('chat_filter_update', {
      serverId: server.id,
      detail: `${filter.enabled ? 'on' : 'off'}: ${filter.keywords.length} palavra(s)`,
      ip: req.ip,
    });
    res.json(updated?.chatFilter ?? filter);
  });

  router.get('/servers/:id/config', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    res.json(withoutSecrets(readConfig(server)));
  });

  router.put('/servers/:id/config', requireWritable, (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const values = req.body?.values ?? {};
    validateValues(values);
    // Chaves passadas como +convar no boot só valem se o cadastro acompanhar,
    // senão o servidor reiniciaria com o valor antigo da linha de comando.
    const updated = updateServer(server.id, launchPatch(values));
    const result = writeConfig(updated ?? server, values);
    if (updated) runtimeManager.sync(loadConfig().servers);
    audit('config_update', { serverId: server.id, detail: Object.keys(values).join(','), ip: req.ip });
    res.json(withoutSecrets(result));
  });

  router.post('/servers/:id/discord/test', async (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    if (!server.discord?.webhookUrl) throw new ValidationError('Configure e salve a URL do webhook primeiro.');
    try {
      await sendDiscord(server, 'test', {
        title: 'Teste de alerta',
        description: 'Se você está vendo esta mensagem, os alertas do Rust Mission Control estão funcionando.',
      });
    } catch (error) {
      res.status(502).json({ error: error.name === 'TimeoutError' ? 'Tempo esgotado ao contatar o Discord.' : error.message });
      return;
    }
    res.json({ ok: true });
  });

  router.get('/servers/:id/backups', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    res.json(listBackups(server));
  });

  router.post('/servers/:id/backups', async (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const backup = await createBackup(server, runtimeManager.get(server.id), { label: req.body?.label ?? 'manual' });
    audit('backup_create', { serverId: server.id, detail: backup.name, ip: req.ip });
    res.status(201).json(backup);
  });

  router.post('/servers/:id/backups/:name/restore', async (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const result = await restoreBackup(server, runtimeManager.get(server.id), req.params.name);
    audit('backup_restore', { serverId: server.id, detail: req.params.name, ip: req.ip });
    res.json(result);
  });

  router.delete('/servers/:id/backups/:name', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    deleteBackup(server, req.params.name);
    audit('backup_delete', { serverId: server.id, detail: req.params.name, ip: req.ip });
    res.json({ ok: true });
  });

  router.get('/servers/:id/samples', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const range = String(req.query.range || '');
    if (!range) {
      res.json(listSamples(server.id, Number(req.query.limit) || 120));
      return;
    }
    const hours = SAMPLE_RANGES[range];
    if (!hours) {
      res.status(400).json({ error: 'Intervalo inválido. Use 24h, 7d ou 30d.' });
      return;
    }
    const until = Date.now();
    const since = until - hours * 60 * 60 * 1000;
    const bucketMs = Math.max(60_000, Math.ceil((until - since) / MAX_POINTS / 60_000) * 60_000);
    res.json({ range, bucketMs, since, until, samples: listSamplesRange(server.id, { since, until, bucketMs }) });
  });

  router.get('/servers/:id/oxide', async (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const status = oxideStatus(server);
    res.json(status);
  });

  router.post('/servers/:id/oxide/install', requireWritable, async (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const runtime = runtimeManager.get(server.id);
    const state = runtime?.status().state;
    if (state === 'running' || state === 'starting') {
      throw new ConflictError('Pare o servidor antes de instalar ou atualizar o Oxide.');
    }
    const result = await installOrUpdateOxide(server);
    audit('oxide_install', { serverId: server.id, detail: result.version, ip: req.ip });
    res.json({ ...result, installed: isOxideInstalled(server) });
  });

  router.get('/servers/:id/oxide/plugins', async (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const plugins = listPlugins(server);
    // Estado "carregado" só faz sentido com o servidor no ar; falha silenciosa fora do ar.
    let loaded = new Set();
    const runtime = runtimeManager.get(server.id);
    if (runtime?.status().state === 'running') loaded = await detectLoadedPlugins(runtime);
    res.json(plugins.map((plugin) => ({ ...plugin, loaded: loaded.has(plugin.name.toLowerCase()) })));
  });

  router.post('/servers/:id/oxide/plugins', requireWritable, async (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const url = req.body?.url;
    const content = req.body?.content;
    if (url) {
      const result = await installPluginFromUmod(server, url);
      audit('oxide_plugin_install', { serverId: server.id, detail: result.url, ip: req.ip });
      res.status(201).json(result);
      return;
    }
    if (content) {
      const result = savePluginContent(server, req.body?.name, content);
      audit('oxide_plugin_upload', { serverId: server.id, detail: result.name, ip: req.ip });
      res.status(201).json(result);
      return;
    }
    throw new ValidationError('Informe a URL do uMod ou o conteúdo do plugin.');
  });

  router.delete('/servers/:id/oxide/plugins/:name', requireWritable, (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const result = deletePlugin(server, req.params.name);
    audit('oxide_plugin_delete', { serverId: server.id, detail: result.name, ip: req.ip });
    res.json({ ok: true });
  });

  router.get('/servers/:id/oxide/plugins/:name/config', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    res.json(readPluginConfig(server, req.params.name));
  });

  router.put('/servers/:id/oxide/plugins/:name/config', requireWritable, (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const result = writePluginConfig(server, req.params.name, req.body?.raw);
    audit('oxide_plugin_config', { serverId: server.id, detail: req.params.name, ip: req.ip });
    res.json(result);
  });

  const PLUGIN_ACTIONS = ['load', 'unload', 'reload'];
  router.post('/servers/:id/oxide/plugins/:name/:action', async (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    if (!PLUGIN_ACTIONS.includes(req.params.action)) {
      res.status(404).json({ error: 'Ação desconhecida. Use load, unload ou reload.' });
      return;
    }
    const runtime = requireRuntime(req, res);
    if (!runtime) return;
    const response = await runtime.command(`oxide.${req.params.action} ${req.params.name}`);
    audit(`oxide_plugin_${req.params.action}`, { serverId: server.id, detail: req.params.name, ip: req.ip });
    res.json({ response });
  });

  router.get('/audit', (req, res) => {
    res.json(listAudit(Number(req.query.limit) || 100));
  });

  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const filter = typeof req.query.serverId === 'string' ? req.query.serverId : null;
    const send = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    send({ type: 'hello', servers: runtimeManager.all().map((runtime) => runtime.status()) });

    const onEvent = (event) => {
      if (filter && event.serverId !== filter) return;
      send(event);
    };
    logBus.on('event', onEvent);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(heartbeat);
      logBus.off('event', onEvent);
    });
  });

  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status ?? 500;
    if (status >= 500) console.error('[api]', err);
    res.status(status).json({ error: err.message ?? 'Erro interno.' });
  });

  return router;
}

/**
 * O painel só pode mostrar "online" com o servidor rodando. Se o runtime não
 * está rodando (parado, com erro ou depois de reiniciar o agente), as sessões
 * abertas no banco são resíduo e precisam ser fechadas antes de listar.
 */
function reconcileSessions(server) {
  const runtime = runtimeManager.get(server.id);
  if (runtime?.status().state !== 'running') closeSessions(server.id);
}

function requireServer(req, res) {
  const server = findServer(req.params.id);
  if (!server) {
    res.status(404).json({ error: 'Servidor não encontrado.' });
    return null;
  }
  return server;
}

function requireRuntime(req, res) {
  const runtime = runtimeManager.get(req.params.id);
  if (!runtime) {
    res.status(404).json({ error: 'Servidor não encontrado.' });
    return null;
  }
  return runtime;
}

/**
 * Replica um ban nos demais servidores do mesmo grupo (ou em todos os outros
 * servidores do agente, quando o servidor de origem não tem grupo). Servidores
 * offline são reportados como ignorados, sem derrubar a ação principal.
 */
async function syncBan(sourceRuntime, { steamId, name, reason, minutes }) {
  const config = loadConfig();
  const source = config.servers.find((server) => server.id === sourceRuntime.server.id);
  const targets = config.servers.filter(
    (server) => server.id !== sourceRuntime.server.id && (source?.group ? server.group === source.group : true),
  );
  const results = [];
  for (const target of targets) {
    const runtime = runtimeManager.get(target.id);
    if (!runtime || runtime.state !== 'running' || !runtime.rcon?.connected) {
      results.push({
        id: target.id,
        name: target.name,
        ok: false,
        skipped: true,
        error: 'Servidor offline ou RCON desconectado.',
      });
      continue;
    }
    try {
      await runtime.moderate({
        action: 'ban',
        steamId,
        name,
        reason,
        minutes,
        actor: 'sync',
        synced: { from: sourceRuntime.server.id },
      });
      results.push({ id: target.id, name: target.name, ok: true });
    } catch (error) {
      results.push({ id: target.id, name: target.name, ok: false, error: error.message });
    }
  }
  return {
    group: source?.group ?? null,
    total: results.length,
    applied: results.filter((item) => item.ok).length,
    results,
  };
}
