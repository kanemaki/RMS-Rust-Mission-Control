import express from 'express';
import {
  addServer,
  detectInstall,
  findServer,
  loadConfig,
  publicServer,
  removeServer,
  updateServer,
  ValidationError,
} from './store.js';
import { runtimeManager } from './process-manager.js';
import { ConflictError } from './errors.js';
import { logBus } from './logbus.js';
import { readConfig, writeConfig } from './cfg.js';
import { createBackup, deleteBackup, listBackups, restoreBackup } from './backups.js';
import { audit, listAudit, listSamples } from './db.js';
import { scanInstall } from './discover.js';
import {
  clearCookie,
  createSession,
  destroySession,
  loginRateLimit,
  needsSetup,
  requireAuth,
  resetLoginAttempts,
  sessionCookie,
  setPassword,
  tokenFromRequest,
  verifyPassword,
} from './auth.js';

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
    const { token } = createSession({ ip: req.ip, userAgent: req.get('user-agent') });
    res.setHeader('Set-Cookie', sessionCookie(token, { secure: secureCookies }));
    audit('login', { ip: req.ip });
    res.json({ ok: true });
  });

  router.post('/auth/logout', (req, res) => {
    destroySession(tokenFromRequest(req));
    res.setHeader('Set-Cookie', clearCookie());
    res.json({ ok: true });
  });

  router.get('/auth/me', requireAuth, (req, res) => {
    res.json({ authenticated: true, expiresAt: req.session.expiresAt });
  });

  router.use(requireAuth);

  const localOnly = (req, res, next) => {
    const server = findServer(req.params.id);
    if (server?.mode === 'remote') {
      res.status(409).json({ error: 'Recurso disponível apenas para servidores locais.' });
      return;
    }
    next();
  };
  router.use(['/servers/:id/config', '/servers/:id/backups'], localOnly);

  router.get('/discover', (req, res) => {
    res.json({ defaultInstallDir: detectInstall()?.installDir ?? '' });
  });

  router.post('/discover', (req, res) => {
    const scan = scanInstall(req.body?.installDir);
    audit('discover_scan', { detail: scan.installDir, ip: req.ip });
    res.json(scan);
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

  router.post('/servers', (req, res) => {
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

  router.patch('/servers/:id', (req, res) => {
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

  router.delete('/servers/:id', async (req, res) => {
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

  router.get('/servers/:id/logs', (req, res) => {
    const runtime = requireRuntime(req, res);
    if (!runtime) return;
    res.json(logBus.history(runtime.server.id, Number(req.query.limit) || 300));
  });

  router.get('/servers/:id/config', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    res.json(readConfig(server));
  });

  router.put('/servers/:id/config', (req, res) => {
    const server = requireServer(req, res);
    if (!server) return;
    const result = writeConfig(server, req.body?.values ?? {});
    audit('config_update', { serverId: server.id, detail: Object.keys(req.body?.values ?? {}).join(','), ip: req.ip });
    res.json(result);
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
    res.json(listSamples(server.id, Number(req.query.limit) || 120));
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
