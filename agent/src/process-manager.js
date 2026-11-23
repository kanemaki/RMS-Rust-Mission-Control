import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RconClient } from './rcon.js';
import { logBus } from './logbus.js';
import { updateServerFiles } from './steamcmd.js';
import { isOxideInstalled, installOrUpdateOxide } from './oxide.js';
import { serverLogsDir } from './paths.js';
import { recordSample } from './db.js';
import { createLineSplitter } from './lines.js';
import { parsePlayerList } from './playerlist.js';
import { trackPlayers, closeSessions, dueBans, resolveBans, recordModeration, normalizeAction, normalizeSteamId } from './players.js';
import { parseChatMessage, recordChat } from './chat.js';
import { createBackup } from './backups.js';
import { ConflictError } from './errors.js';
import { notifyDiscord } from './discord.js';
import { clearWipeData, nextMonthlyWipeAt } from './wipe-scheduler.js';
import { nextDailyBackupAt, pruneScheduledBackups } from './backup-scheduler.js';
import { nextDailyAt, nextIntervalAt, sanitizeAnnouncement } from './schedule.js';
import { updateServer } from './store.js';

const READY_RE = /server startup complete|steamServer initialized|server initialized/i;
const PLAYER_POLL_MS = 15000;
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const HEALTHY_UPTIME_MS = 5 * 60 * 1000;
const WIPE_WARNINGS = [10, 5, 1];
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

export { ConflictError };

export class ServerRuntime {
  constructor(server) {
    this.server = server;
    this.state = 'stopped';
    this.remote = server.mode === 'remote';
    this.child = null;
    this.pid = null;
    this.startedAt = null;
    this.stoppedAt = null;
    this.lastError = null;
    this.players = null;
    this.playerNames = [];
    this.maxPlayers = server.maxPlayers;
    this.rcon = null;
    this.busy = false;
    this.intentionalStop = false;
    this.restartCount = 0;
    this.restartTimer = null;
    this.wipeTimer = null;
    this.wipeInProgress = false;
    this.scheduledWipeAt = null;
    this.wipeWarningThreshold = null;
    this.backupTimer = null;
    this.backupInProgress = false;
    this.scheduledBackupAt = null;
    this.restartScheduleTimer = null;
    this.restartInProgress = false;
    this.scheduledRestartAt = null;
    this.restartWarningThreshold = null;
    this.updateScheduleTimer = null;
    this.updateInProgress = false;
    this.scheduledUpdateAt = null;
    this.announceTimer = null;
    this.scheduledAnnouncementAt = null;
    this.announceIndex = 0;
    this.readyTimer = null;
    this.playerTimer = null;
    this.banTimer = setInterval(() => void this.#expireBans(), 30000);
    this.banTimer.unref?.();
    this.logStream = null;
    this.logStreamDay = null;
    this.lastLines = [];
    this.#scheduleWipe();
    this.#scheduleBackup();
    this.#scheduleDailyRestart();
    this.#scheduleUpdate();
    this.#scheduleAnnouncements();
  }

  applyConfig(server) {
    const rconChanged =
      this.server.rconPort !== server.rconPort ||
      this.server.rconPassword !== server.rconPassword ||
      this.server.host !== server.host;
    this.server = server;
    this.remote = server.mode === 'remote';
    this.maxPlayers = server.maxPlayers;
    if (rconChanged && this.state === 'running') {
      this.#log('agent', 'Configuração de RCON mudou; reinicie o servidor para aplicar.');
    }
    this.#scheduleWipe();
    this.#scheduleBackup();
    this.#scheduleDailyRestart();
    this.#scheduleUpdate();
    this.#scheduleAnnouncements();
    logBus.status(this.server.id, this.status());
  }

  status() {
    const executable = this.#executablePath();
    const override = this.server.startedAtOverride;
    const uptimeBase = override ?? this.startedAt;
    const uptimeSource = override ? 'manual' : this.startedAt ? (this.remote ? 'session' : 'process') : null;
    return {
      id: this.server.id,
      mode: this.server.mode,
      host: this.remote ? this.server.host : '127.0.0.1',
      state: this.state,
      pid: this.pid,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      uptimeMs:
        uptimeBase && this.state !== 'stopped' && this.state !== 'error'
          ? Math.max(0, Date.now() - uptimeBase)
          : 0,
      uptimeSource,
      players: this.players,
      playerNames: this.playerNames,
      maxPlayers: this.maxPlayers,
      rconConnected: Boolean(this.rcon?.connected),
      lastError: this.lastError,
      autoRestart: this.server.autoRestart,
      autoUpdate: this.server.autoUpdate,
      nextWipeAt: this.scheduledWipeAt,
      nextBackupAt: this.scheduledBackupAt,
      nextRestartAt: this.scheduledRestartAt,
      nextUpdateAt: this.scheduledUpdateAt,
      nextAnnouncementAt: this.scheduledAnnouncementAt,
      install: this.remote
        ? null
        : {
            installed: fs.existsSync(executable),
            executable,
            steamCmd: true,
          },
    };
  }

  async start({ skipUpdate = false, scheduledWipe = false } = {}) {
    this.#assertIdle(scheduledWipe);
    if (this.state === 'running' || this.state === 'starting') {
      throw new ConflictError('O servidor já está em execução.');
    }
    if (this.remote) return this.#connectRemote();
    this.busy = true;
    this.intentionalStop = false;
    this.lastError = null;
    try {
      if (this.server.autoUpdate && !skipUpdate) {
        const result = await this.#runUpdate();
        if (!result.ok) {
          const installed = fs.existsSync(this.#executablePath());
          this.#log(
            'agent',
            installed
              ? `Aviso: atualização falhou (${result.error ?? `código ${result.code}`}). Iniciando com a instalação existente.`
              : `Atualização falhou (${result.error ?? `código ${result.code}`}) e não há instalação local.`,
          );
          if (!installed) throw new Error('Não foi possível instalar o servidor: a atualização pelo SteamCMD falhou.');
        }
      }
      this.#spawn();
    } finally {
      this.busy = false;
    }
    return this.status();
  }

  async stop({ graceful = true, scheduledWipe = false } = {}) {
    if (this.busy || (this.wipeInProgress && !scheduledWipe)) {
      throw new ConflictError('Outra operação está em andamento.');
    }
    if (this.state === 'stopped' || this.state === 'error') {
      // O runtime já está parado, mas podem existir sessões abertas de uma
      // execução anterior (agente reiniciado, processo morto por fora).
      closeSessions(this.server.id);
      return this.status();
    }
    if (this.remote) {
      this.intentionalStop = true;
      this.rcon?.stop();
      this.rcon = null;
      clearInterval(this.playerTimer);
      this.players = null;
      closeSessions(this.server.id);
      this.stoppedAt = Date.now();
      this.#setState('stopped');
      this.#log('agent', 'Desconectado do servidor remoto.');
      return this.status();
    }
    this.busy = true;
    this.intentionalStop = true;
    clearTimeout(this.restartTimer);
    this.#setState('stopping');
    try {
      const canQuit = graceful && this.rcon?.connected;
      if (canQuit) {
        this.#log('agent', 'Enviando "quit" via RCON...');
        try {
          await this.rcon.send('quit', 5000);
        } catch {
          /* segue para o kill */
        }
      }
      const exited = await this.#waitExit(canQuit ? 20000 : 1500);
      if (!exited && this.pid) {
        this.#log('agent', 'Encerrando processo à força (árvore de processos).');
        await killTree(this.pid);
        await this.#waitExit(8000);
      }
    } finally {
      this.busy = false;
    }
    return this.status();
  }

  async restart(options = {}) {
    this.#assertIdle();
    await this.stop();
    return this.start(options);
  }

  async update() {
    if (this.wipeInProgress || this.busy) throw new ConflictError('Outra operação está em andamento.');
    return this.#runUpdate();
  }

  async #runUpdate() {
    if (this.remote) {
      throw new ConflictError('Servidor remoto: atualize os arquivos na máquina de origem.');
    }
    if (this.state === 'running' || this.state === 'starting' || this.state === 'stopping') {
      throw new ConflictError('Pare o servidor antes de atualizar.');
    }
    const previous = this.state;
    const hadOxide = isOxideInstalled(this.server);
    this.#setState('updating');
    this.#log('agent', 'Iniciando atualização via SteamCMD (app 258550)...');
    const result = await updateServerFiles(this.server, {
      onLine: ({ stream, line }) => this.#log(stream, line),
    });
    this.#setState(previous === 'error' ? 'error' : 'stopped');
    if (result.ok) {
      this.#log('agent', 'Atualização concluída.');
      if (hadOxide) {
        this.#log('agent', 'Reinstalando o Oxide após a atualização...');
        try {
          await installOrUpdateOxide(this.server);
          this.#log('agent', 'Oxide reinstalado.');
        } catch (error) {
          this.#log('agent', `Aviso: falha ao reinstalar o Oxide (${error.message}). Reinstale pela aba Plugins.`);
        }
      }
    } else {
      this.lastError = result.error ?? `SteamCMD retornou código ${result.code}`;
      this.#log('agent', `Atualização falhou: ${this.lastError}`);
    }
    return result;
  }

  async command(command) {
    if (!this.rcon?.connected) throw new ConflictError('RCON não está conectado.');
    const response = await this.rcon.send(command);
    this.#log('rcon', `> ${command}`);
    if (response) this.#log('rcon', response);
    return response;
  }

  /**
   * Executa uma ação de moderação via RCON e registra no histórico.
   * Ban temporizado é implementado como `banid` + `unban` agendado, porque o
   * Rust vanilla não aceita duração no comando de ban.
   */
  async moderate({ action, steamId, name = '', reason = '', minutes = null, actor = 'panel', synced = null }) {
    if (!this.rcon?.connected) throw new ConflictError('RCON não está conectado.');
    const normalizedAction = normalizeAction(action);
    const id = normalizeSteamId(steamId);
    const cleanReason = String(reason ?? '')
      .replace(/[\r\n"]/g, ' ')
      .trim()
      .slice(0, 300);
    const cleanName = String(name ?? '')
      .replace(/[\r\n"]/g, ' ')
      .trim()
      .slice(0, 64) || id;
    const now = Date.now();
    const expiresAt = normalizedAction === 'ban' && minutes ? now + minutes * 60000 : null;

    let command;
    if (normalizedAction === 'kick') command = `kick ${id}${cleanReason ? ` "${cleanReason}"` : ''}`;
    else if (normalizedAction === 'ban') command = `banid ${id}${cleanReason ? ` "${cleanReason}"` : ''}`;
    else if (normalizedAction === 'unban') command = `unban ${id}`;
    else if (normalizedAction === 'mute') command = `mute ${id}`;
    else if (normalizedAction === 'unmute') command = `unmute ${id}`;
    else if (normalizedAction === 'owner') command = `ownerid ${id} "${cleanName}" "${cleanReason || 'painel'}"`;
    else command = `removeowner ${id} "${cleanName}" "${cleanReason || 'painel'}"`;

    const response = await this.command(command);
    if (normalizedAction === 'unban') resolveBans(this.server.id, id, now);
    const moderation = recordModeration({
      serverId: this.server.id,
      steamId: id,
      name,
      action: normalizedAction,
      reason: cleanReason,
      minutes: normalizedAction === 'ban' ? minutes : null,
      expiresAt,
      actor,
      synced,
      ts: now,
    });
    return { response, moderation };
  }

  async #expireBans() {
    if (this.state !== 'running' || !this.rcon?.connected) return;
    const due = dueBans(this.server.id);
    for (const ban of due) {
      try {
        await this.command(`unban ${ban.steamId}`);
        resolveBans(this.server.id, ban.steamId);
        recordModeration({
          serverId: this.server.id,
          steamId: ban.steamId,
          name: ban.name,
          action: 'unban',
          reason: 'Expiração automática do ban temporizado',
          actor: 'scheduler',
        });
        this.#log('agent', `Ban temporizado expirado: ${ban.name} (${ban.steamId}).`);
        void this.#notify(
          'moderation',
          'Ban temporizado expirado',
          `${ban.name} (${ban.steamId}) foi desbanido automaticamente.`,
        );
      } catch (error) {
        this.#log('agent', `Falha ao remover ban expirado de ${ban.steamId}: ${error.message}`);
      }
    }
  }

  dispose() {
    clearTimeout(this.restartTimer);
    clearTimeout(this.wipeTimer);
    clearTimeout(this.backupTimer);
    clearTimeout(this.restartScheduleTimer);
    clearTimeout(this.updateScheduleTimer);
    clearTimeout(this.announceTimer);
    clearTimeout(this.readyTimer);
    clearInterval(this.playerTimer);
    clearInterval(this.banTimer);
    this.rcon?.stop();
    this.#closeLogStream();
    closeSessions(this.server.id);
  }

  async #connectRemote() {
    this.busy = true;
    this.intentionalStop = false;
    this.lastError = null;
    this.startedAt = null;
    this.#setState('starting');
    this.#log('agent', `Conectando ao RCON remoto em ${this.server.host}:${this.server.rconPort}...`);
    this.#startRcon();
    const connected = await this.#waitRcon(15000);
    this.busy = false;
    if (!connected) {
      this.rcon?.stop();
      this.rcon = null;
      this.lastError = `Não foi possível conectar ao RCON em ${this.server.host}:${this.server.rconPort}. Verifique a porta, a senha e o firewall.`;
      this.#setState('error');
      this.#log('agent', this.lastError);
      throw new Error(this.lastError);
    }
    return this.status();
  }

  #waitRcon(timeoutMs) {
    if (this.rcon?.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.rcon?.off('connection', onConnection);
        resolve(false);
      }, timeoutMs);
      const onConnection = (connected) => {
        if (!connected) return;
        clearTimeout(timer);
        this.rcon?.off('connection', onConnection);
        resolve(true);
      };
      this.rcon?.on('connection', onConnection);
    });
  }

  #assertIdle(allowScheduledWipe = false) {
    if (this.busy || (this.wipeInProgress && !allowScheduledWipe)) {
      throw new ConflictError('Outra operação está em andamento.');
    }
  }

  #executablePath() {
    const exe = this.server.executable;
    return path.isAbsolute(exe) ? exe : path.join(this.server.installDir, exe);
  }

  #buildArgs(logFile) {
    const s = this.server;
    return [
      ...s.executableArgs,
      '-batchmode',
      '-nographics',
      '+server.hostname',
      s.hostname,
      '+server.port',
      String(s.port),
      '+server.identity',
      s.identity,
      '+server.seed',
      String(s.seed),
      '+server.worldsize',
      String(s.worldSize),
      '+server.maxplayers',
      String(s.maxPlayers),
      '+server.saveinterval',
      String(s.saveInterval),
      '+rcon.port',
      String(s.rconPort),
      '+rcon.password',
      s.rconPassword,
      '+rcon.web',
      '1',
      '-logFile',
      logFile,
      ...s.extraArgs,
    ];
  }

  #spawn() {
    const executable = this.#executablePath();
    if (!fs.existsSync(executable)) {
      this.lastError = `Executável não encontrado: ${executable}. Rode a atualização para instalar o servidor.`;
      this.#setState('error');
      throw new Error(this.lastError);
    }
    if (!fs.existsSync(this.server.installDir)) {
      throw new Error(`Pasta de instalação inexistente: ${this.server.installDir}`);
    }

    const logFile = path.join(serverLogsDir(this.server.id), `rust-${stamp()}.log`);
    const args = this.#buildArgs(logFile);
    this.#log('agent', `Iniciando: ${executable} (porta ${this.server.port}, RCON ${this.server.rconPort})`);

    const child = spawn(executable, args, {
      cwd: this.server.installDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child = child;
    this.pid = child.pid ?? null;
    this.startedAt = Date.now();
    this.stoppedAt = null;
    this.players = 0;
    this.#setState('starting');

    const out = createLineSplitter((line) => this.#handleLine('stdout', line));
    const err = createLineSplitter((line) => this.#handleLine('stderr', line));
    child.stdout.on('data', out.push);
    child.stderr.on('data', err.push);

    this.readyTimer = setTimeout(() => {
      if (this.state === 'starting') {
        this.#log('agent', 'O servidor não confirmou inicialização em 3 minutos; mantendo o processo ativo.');
        this.#setState('running');
      }
    }, 180000);

    child.on('error', (error) => {
      this.lastError = error.message;
      this.#log('agent', `Falha ao executar: ${error.message}`);
      this.#setState('error');
    });

    child.on('close', (code, signal) => {
      out.flush();
      err.flush();
      clearTimeout(this.readyTimer);
      clearInterval(this.playerTimer);
      this.rcon?.stop();
      this.rcon = null;
      this.#closeLogStream();
      this.child = null;
      this.pid = null;
      this.stoppedAt = Date.now();
      this.players = null;
      closeSessions(this.server.id);
      this.#log('agent', `Processo encerrado (código ${code ?? 'null'}${signal ? `, sinal ${signal}` : ''}).`);

      const wasIntentional = this.intentionalStop || this.state === 'stopping';
      this.#setState(!wasIntentional && code !== 0 ? 'error' : 'stopped');
      if (!wasIntentional) this.#scheduleRestart();
    });

    this.#startRcon();
  }

  #startRcon() {
    this.rcon?.stop();
    const rcon = new RconClient({
      host: this.remote ? this.server.host : '127.0.0.1',
      port: this.server.rconPort,
      password: this.server.rconPassword,
      label: this.server.id,
    });
    rcon.on('log', ({ line }) => this.#log('rcon', line));
    rcon.on('connection', (connected) => {
      if (connected) {
        this.#pollPlayers();
        this.playerTimer = setInterval(() => this.#pollPlayers(), PLAYER_POLL_MS);
        if (this.remote && this.state === 'starting') {
          this.startedAt = Date.now();
          this.#setState('running');
        }
      } else {
        clearInterval(this.playerTimer);
        if (this.remote && this.state === 'running' && !this.intentionalStop) {
          this.lastError = 'Conexão RCON perdida.';
          this.#setState('error');
        }
      }
      logBus.status(this.server.id, this.status());
    });
    rcon.on('message', (message) => {
      if (message?.Type === 'Chat') {
        this.#log('chat', formatChat(message));
        const parsed = parseChatMessage(message);
        if (parsed) {
          const entry = recordChat({
            serverId: this.server.id,
            ...parsed,
            filter: this.server.chatFilter,
          });
          if (entry) {
            logBus.chat(this.server.id, entry);
            if (entry.flagged) {
              void this.#notify(
                'moderation',
                'Mensagem sinalizada no chat',
                `${entry.username ?? 'Jogador'}: ${entry.message}\nRegra: ${entry.rule}`,
              );
            }
          }
        }
      } else if (message?.Message) {
        this.#log('rcon', String(message.Message));
      }
    });
    this.rcon = rcon;
    rcon.start();
  }

  async #pollPlayers() {
    if (!this.rcon?.connected) return;
    try {
      const response = await this.rcon.send('playerlist', 8000);
      const parsed = parsePlayerList(response);
      if (!parsed) {
        this.#log('rcon', `playerlist sem formato reconhecido: ${String(response).slice(0, 200)}`);
        return;
      }
      this.players = parsed.players;
      if (parsed.maxPlayers) this.maxPlayers = parsed.maxPlayers;
      this.playerNames = parsed.names;
      if (parsed.structured) trackPlayers(this.server.id, parsed.list);
      logBus.status(this.server.id, this.status());
    } catch {
      /* silencioso: o próximo ciclo tenta de novo */
    }
  }

  #handleLine(stream, line) {
    if (!line.trim()) return;
    this.#log(stream, line);
    if (this.state === 'starting' && READY_RE.test(line)) {
      clearTimeout(this.readyTimer);
      this.#setState('running');
      this.#log('agent', 'Servidor pronto.');
    }
  }

  #scheduleDailyRestart() {
    clearTimeout(this.restartScheduleTimer);
    this.restartWarningThreshold = null;
    const schedule = this.server.restartSchedule;
    if (!schedule?.enabled || this.remote) {
      this.scheduledRestartAt = null;
      return;
    }
    this.scheduledRestartAt = nextDailyAt(schedule.time);
    this.#armDailyRestartTimer();
  }

  #armDailyRestartTimer() {
    if (!this.scheduledRestartAt || this.restartInProgress) return;
    const remaining = this.scheduledRestartAt - Date.now();
    if (remaining <= 0) {
      this.restartWarningThreshold = null;
      this.restartScheduleTimer = setTimeout(() => void this.#runScheduledRestart(), 0);
      return;
    }

    const threshold = WIPE_WARNINGS.find((minutes) => remaining > minutes * 60 * 1000);
    this.restartWarningThreshold = threshold ?? null;
    const targetAt = threshold ? this.scheduledRestartAt - threshold * 60 * 1000 : this.scheduledRestartAt;
    const delay = Math.min(Math.max(0, targetAt - Date.now()), MAX_TIMER_MS);
    this.restartScheduleTimer = setTimeout(() => {
      if (Date.now() < targetAt - 1000) {
        this.#armDailyRestartTimer();
        return;
      }
      if (this.scheduledRestartAt - Date.now() <= 0) {
        void this.#runScheduledRestart();
        return;
      }
      const remainingNow = this.scheduledRestartAt - Date.now();
      const warningMs = this.restartWarningThreshold * 60 * 1000;
      if (this.restartWarningThreshold && Math.abs(remainingNow - warningMs) <= 30_000) {
        void this.#sendRestartWarning(this.restartWarningThreshold);
      }
      this.#armDailyRestartTimer();
    }, delay);
    this.restartScheduleTimer.unref?.();
  }

  async #sendRestartWarning(minutes) {
    if (this.state !== 'running' || !this.rcon?.connected) return;
    const notice = `Server restart in ${minutes} min / Reinício do servidor em ${minutes} min.`;
    try {
      await this.command(`say ${notice}`);
    } catch (error) {
      this.#log('agent', `Não foi possível enviar o aviso do reinício (${minutes} min): ${error.message}`);
    }
  }

  async #runScheduledRestart() {
    if (this.restartInProgress || !this.server.restartSchedule?.enabled || this.remote) return;
    this.restartInProgress = true;
    clearTimeout(this.restartScheduleTimer);
    try {
      if (this.wipeInProgress || this.updateInProgress || ['starting', 'stopping', 'updating'].includes(this.state)) {
        this.#log('agent', 'Reinício agendado ignorado: o servidor está em outra operação.');
        return;
      }
      if (this.state !== 'running') {
        this.#log('agent', 'Reinício agendado ignorado: o servidor não está em execução.');
        return;
      }
      if (this.server.restartSchedule.onlyIfEmpty && (this.players ?? 0) > 0) {
        this.#log('agent', `Reinício agendado ignorado: ${this.players} jogador(es) online.`);
        void this.#notify(
          'restart',
          'Reinício agendado ignorado',
          `${this.players} jogador(es) online no horário previsto.`,
        );
        return;
      }
      this.#log('agent', 'Iniciando reinício agendado...');
      try {
        await this.command('say Reinício do servidor agora / Server restarting now.');
      } catch {
        /* segue para o reinício */
      }
      await this.restart({ skipUpdate: true });
      this.#log('agent', 'Reinício agendado concluído.');
      void this.#notify('restart', 'Reinício agendado concluído', 'O servidor foi reiniciado no horário programado.');
    } catch (error) {
      this.#log('agent', `Falha no reinício agendado: ${error.message}`);
      void this.#notify('restart', 'Falha no reinício agendado', error.message);
    } finally {
      this.restartInProgress = false;
      this.#scheduleDailyRestart();
      logBus.status(this.server.id, this.status());
    }
  }

  #scheduleUpdate() {
    clearTimeout(this.updateScheduleTimer);
    const schedule = this.server.updateSchedule;
    if (!schedule?.enabled || this.remote) {
      this.scheduledUpdateAt = null;
      return;
    }
    this.scheduledUpdateAt = nextDailyAt(schedule.time);
    this.#armUpdateTimer();
  }

  #armUpdateTimer() {
    if (!this.scheduledUpdateAt || this.updateInProgress) return;
    const delay = Math.min(Math.max(0, this.scheduledUpdateAt - Date.now()), MAX_TIMER_MS);
    this.updateScheduleTimer = setTimeout(() => {
      if (this.scheduledUpdateAt - Date.now() > 1000) {
        this.#armUpdateTimer();
        return;
      }
      void this.#runScheduledUpdate();
    }, delay);
    this.updateScheduleTimer.unref?.();
  }

  async #runScheduledUpdate() {
    if (this.updateInProgress || !this.server.updateSchedule?.enabled || this.remote) return;
    this.updateInProgress = true;
    clearTimeout(this.updateScheduleTimer);
    const wasRunning = this.state === 'running';
    try {
      if (this.wipeInProgress || ['starting', 'stopping', 'updating'].includes(this.state)) {
        this.#log('agent', 'Atualização agendada ignorada: o servidor está em outra operação.');
        return;
      }
      this.#log('agent', 'Iniciando atualização agendada...');
      if (wasRunning) {
        try {
          await this.command('say Atualização do servidor agora / Server updating now.');
        } catch {
          /* segue para a parada */
        }
        await this.stop();
      }
      const result = await this.#runUpdate();
      if (result.ok) {
        this.#log('agent', 'Atualização agendada concluída.');
        void this.#notify('update', 'Atualização agendada concluída', 'Os arquivos do servidor foram atualizados.');
      } else {
        void this.#notify(
          'update',
          'Falha na atualização agendada',
          result.error ?? `SteamCMD retornou código ${result.code}`,
        );
      }
      if (wasRunning && this.server.updateSchedule.restartAfter) {
        await this.start({ skipUpdate: true });
      }
    } catch (error) {
      this.#log('agent', `Falha na atualização agendada: ${error.message}`);
      void this.#notify('update', 'Falha na atualização agendada', error.message);
    } finally {
      this.updateInProgress = false;
      this.#scheduleUpdate();
      logBus.status(this.server.id, this.status());
    }
  }

  #scheduleAnnouncements() {
    clearTimeout(this.announceTimer);
    const config = this.server.announcements;
    if (!config?.enabled || !config.messages?.length) {
      this.scheduledAnnouncementAt = null;
      return;
    }
    this.scheduledAnnouncementAt = nextIntervalAt(config.intervalMinutes);
    this.#armAnnounceTimer();
  }

  #armAnnounceTimer() {
    if (!this.scheduledAnnouncementAt) return;
    const delay = Math.min(Math.max(0, this.scheduledAnnouncementAt - Date.now()), MAX_TIMER_MS);
    this.announceTimer = setTimeout(() => {
      if (this.scheduledAnnouncementAt - Date.now() > 1000) {
        this.#armAnnounceTimer();
        return;
      }
      void this.#runAnnouncement();
    }, delay);
    this.announceTimer.unref?.();
  }

  async #runAnnouncement() {
    clearTimeout(this.announceTimer);
    try {
      if (this.server.announcements?.enabled && this.state === 'running' && this.rcon?.connected) {
        await this.announceNow();
      }
    } catch (error) {
      this.#log('agent', `Falha ao enviar anúncio automático: ${error.message}`);
    } finally {
      this.#scheduleAnnouncements();
      logBus.status(this.server.id, this.status());
    }
  }

  /** Envia um anúncio agora. Sem `message`, usa a próxima da rotação configurada. */
  async announceNow(message = null) {
    const messages = this.server.announcements?.messages ?? [];
    const rotating = message === null || message === undefined;
    const text = sanitizeAnnouncement(rotating ? messages[this.announceIndex % Math.max(1, messages.length)] : message);
    if (!text) throw new ConflictError('Nenhuma mensagem de anúncio configurada.');
    if (!this.rcon?.connected) throw new ConflictError('RCON não está conectado.');
    const response = await this.command(`say ${text}`);
    if (rotating && messages.length) this.announceIndex = (this.announceIndex + 1) % messages.length;
    return { message: text, response };
  }

  #scheduleWipe() {
    clearTimeout(this.wipeTimer);
    this.wipeWarningThreshold = null;
    const schedule = this.server.wipeSchedule;
    if (!schedule?.enabled || this.remote) {
      this.scheduledWipeAt = null;
      return;
    }
    this.scheduledWipeAt = nextMonthlyWipeAt(schedule);
    this.#armWipeTimer();
  }

  #armWipeTimer() {
    if (!this.scheduledWipeAt || this.wipeInProgress) return;
    const remaining = this.scheduledWipeAt - Date.now();
    if (remaining <= 0) {
      this.wipeWarningThreshold = null;
      this.wipeTimer = setTimeout(() => void this.#runScheduledWipe(), 0);
      return;
    }

    const threshold = WIPE_WARNINGS.find((minutes) => remaining > minutes * 60 * 1000);
    this.wipeWarningThreshold = threshold ?? null;
    const targetAt = threshold ? this.scheduledWipeAt - threshold * 60 * 1000 : this.scheduledWipeAt;
    const delay = Math.min(Math.max(0, targetAt - Date.now()), MAX_TIMER_MS);
    this.wipeTimer = setTimeout(() => {
      if (Date.now() < targetAt - 1000) {
        this.#armWipeTimer();
        return;
      }
      if (this.scheduledWipeAt - Date.now() <= 0) {
        void this.#runScheduledWipe();
        return;
      }
      const remainingNow = this.scheduledWipeAt - Date.now();
      const warningMs = this.wipeWarningThreshold * 60 * 1000;
      if (this.wipeWarningThreshold && Math.abs(remainingNow - warningMs) <= 30_000) {
        void this.#sendWipeWarning(this.wipeWarningThreshold);
      }
      this.#armWipeTimer();
    }, delay);
    this.wipeTimer.unref?.();
  }

  async #sendWipeWarning(minutes) {
    if (this.state !== 'running' || !this.rcon?.connected) return;
    const notice = `Server wipe in ${minutes} min / Wipe do servidor em ${minutes} min. Save and disconnect / Salve e desconecte-se.`;
    try {
      await this.command(`say ${notice}`);
    } catch (error) {
      this.#log('agent', `Não foi possível enviar o aviso do wipe (${minutes} min): ${error.message}`);
    }
  }

  async #runScheduledWipe() {
    if (this.wipeInProgress || !this.server.wipeSchedule?.enabled || this.remote) return;
    this.wipeInProgress = true;
    clearTimeout(this.wipeTimer);
    const wasRunning = this.state === 'running';
    let restartNeeded = false;
    let restartAttempted = false;

    try {
      if (['starting', 'stopping', 'updating'].includes(this.state)) {
        this.#log('agent', 'Wipe agendado ignorado: o servidor está em outra operação. O próximo wipe continuará agendado.');
        return;
      }
      if (wasRunning && !this.rcon?.connected) {
        this.#log('agent', 'Wipe agendado cancelado: RCON indisponível, não foi possível garantir os avisos aos jogadores.');
        return;
      }

      const schedule = this.server.wipeSchedule;
      const typeLabel = schedule.type === 'map' ? 'mapa' : schedule.type === 'blueprints' ? 'blueprints' : 'mapa e blueprints';
      this.#log('agent', `Iniciando wipe agendado (${typeLabel}); preparando backup de segurança...`);
      if (wasRunning) {
        try {
          await this.command(`say Wipe iniciado / Limpeza iniciada (${typeLabel}). Retornaremos em breve.`);
        } catch {
          /* segue para o encerramento gracioso */
        }
        await this.stop({ scheduledWipe: true });
        restartNeeded = true;
      }
      const backup = await createBackup(this.server, this, { label: 'scheduled-wipe' });
      this.#log('agent', `Backup de segurança criado: ${backup.name}`);

      const removed = clearWipeData(this.server, schedule.type);
      let nextSeed = null;
      if (schedule.rotateSeed && ['map', 'full'].includes(schedule.type)) {
        nextSeed = crypto.randomInt(0, 2147483648);
        const updated = updateServer(this.server.id, { seed: nextSeed });
        if (updated) this.applyConfig(updated);
      }
      this.#log('agent', `Wipe concluído: ${removed} item(ns) removido(s)${nextSeed === null ? '.' : `; nova seed: ${nextSeed}.`}`);
      void this.#notify(
        'wipe',
        'Wipe concluído',
        `Tipo: ${typeLabel}. ${removed} item(ns) removido(s).${nextSeed === null ? '' : ` Nova seed: ${nextSeed}.`}`,
      );

      if (wasRunning) {
        restartAttempted = true;
        await this.start({ skipUpdate: true, scheduledWipe: true });
      }
    } catch (error) {
      this.#log('agent', `Falha no wipe agendado: ${error.message}`);
      void this.#notify('wipe', 'Falha no wipe agendado', error.message);
      if (restartNeeded && !restartAttempted) {
        restartAttempted = true;
        try {
          await this.start({ skipUpdate: true, scheduledWipe: true });
        } catch (restartError) {
          this.#log('agent', `Falha ao recuperar o servidor após cancelamento do wipe: ${restartError.message}`);
        }
      }
    } finally {
      this.wipeInProgress = false;
      this.#scheduleWipe();
      logBus.status(this.server.id, this.status());
    }
  }

  #scheduleBackup() {
    clearTimeout(this.backupTimer);
    const schedule = this.server.backupSchedule;
    if (!schedule?.enabled || this.remote) {
      this.scheduledBackupAt = null;
      return;
    }
    this.scheduledBackupAt = nextDailyBackupAt(schedule);
    this.#armBackupTimer();
  }

  #armBackupTimer() {
    if (!this.scheduledBackupAt || this.backupInProgress) return;
    const delay = Math.min(Math.max(0, this.scheduledBackupAt - Date.now()), MAX_TIMER_MS);
    this.backupTimer = setTimeout(() => {
      if (this.scheduledBackupAt - Date.now() > 1000) {
        this.#armBackupTimer();
        return;
      }
      void this.#runScheduledBackup();
    }, delay);
    this.backupTimer.unref?.();
  }

  async #runScheduledBackup() {
    if (this.backupInProgress || !this.server.backupSchedule?.enabled || this.remote) return;
    this.backupInProgress = true;
    clearTimeout(this.backupTimer);
    try {
      if (this.wipeInProgress || ['starting', 'stopping', 'updating'].includes(this.state)) {
        this.#log('agent', 'Backup automático adiado: o servidor está em outra operação. Tentará novamente amanhã no mesmo horário.');
        return;
      }
      const schedule = this.server.backupSchedule;
      this.#log('agent', 'Iniciando backup automático...');
      const backup = await createBackup(this.server, this, { label: 'scheduled' });
      const pruned = pruneScheduledBackups(this.server, schedule.keep);
      const removedNote = pruned.length ? ` ${pruned.length} backup(s) antigo(s) removido(s) pela retenção.` : '';
      this.#log('agent', `Backup automático concluído: ${backup.name}.${removedNote}`);
      void this.#notify(
        'backup',
        'Backup automático concluído',
        `Arquivo: ${backup.name}.${removedNote}`,
      );
    } catch (error) {
      this.#log('agent', `Falha no backup automático: ${error.message}`);
      void this.#notify('backup', 'Falha no backup automático', error.message);
    } finally {
      this.backupInProgress = false;
      this.#scheduleBackup();
      logBus.status(this.server.id, this.status());
    }
  }

  #scheduleRestart() {
    if (!this.server.autoRestart) return;
    const now = Date.now();
    if (this.startedAt && now - this.startedAt > HEALTHY_UPTIME_MS) this.restartCount = 0;
    if (this.restartCount >= MAX_RESTARTS) {
      this.lastError = 'Limite de reinícios automáticos atingido. Verifique o console.';
      this.#log('agent', this.lastError);
      this.#setState('error');
      return;
    }
    this.restartCount += 1;
    const delay = Math.min(5000 * 2 ** (this.restartCount - 1), 60000);
    this.#log('agent', `Reiniciando em ${Math.round(delay / 1000)}s (tentativa ${this.restartCount}/${MAX_RESTARTS}).`);
    this.restartTimer = setTimeout(() => {
      this.start({ skipUpdate: true }).catch((err) => {
        this.lastError = err.message;
        this.#log('agent', `Falha no reinício automático: ${err.message}`);
        this.#setState('error');
      });
    }, delay);
  }

  #waitExit(timeoutMs) {
    if (!this.child) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.child.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  #setState(state) {
    if (this.state === state) return;
    const previous = this.state;
    this.state = state;
    recordSample(this.server.id, state, this.players);
    logBus.status(this.server.id, this.status());
    this.#notifyStateChange(previous, state);
  }

  #notifyStateChange(previous, state) {
    if (state === 'running') {
      void this.#notify('online', 'Servidor online', 'O servidor está pronto para receber jogadores.');
    } else if (state === 'stopped' && ['running', 'stopping'].includes(previous)) {
      void this.#notify('offline', 'Servidor offline', 'O servidor foi encerrado.');
    } else if (state === 'error') {
      const reason = this.lastError ? `Motivo: ${this.lastError}` : 'O processo encerrou de forma inesperada.';
      void this.#notify('crash', 'Servidor com falha', reason);
    }
  }

  #notify(kind, title, description) {
    return notifyDiscord(this.server, kind, { title, description }, (line) => this.#log('agent', line));
  }

  #log(stream, line) {
    const entry = logBus.push(this.server.id, { stream, line });
    this.lastLines.push(entry);
    if (this.lastLines.length > 200) this.lastLines.shift();
    this.#writeLogFile(line);
  }

  #writeLogFile(line) {
    try {
      const day = new Date().toISOString().slice(0, 10);
      if (this.logStreamDay !== day) {
        this.#closeLogStream();
        const file = path.join(serverLogsDir(this.server.id), `console-${day}.log`);
        this.logStream = fs.createWriteStream(file, { flags: 'a' });
        this.logStreamDay = day;
      }
      this.logStream.write(`${new Date().toISOString()} ${line}\n`);
    } catch {
      /* não deixa a escrita de log derrubar o agente */
    }
  }

  #closeLogStream() {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }
}

export function formatChat(message) {
  const raw = message?.Message;
  let payload = null;

  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text.startsWith('{')) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
  } else if (raw && typeof raw === 'object') {
    payload = raw;
  }

  if (!payload) return typeof raw === 'string' ? raw : String(raw ?? '');

  const username = String(payload.Username ?? '').trim();
  const body = String(payload.Message ?? '').trim();

  if (!body) return username || '(chat vazio)';
  if (!username) return body;

  return `${username}: ${body}`;
}

export function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* ignora */
        }
      }
      resolve();
      return;
    }
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    killer.on('close', () => resolve());
    killer.on('error', () => resolve());
  });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export class RuntimeManager {
  constructor() {
    this.runtimes = new Map();
  }

  sync(servers) {
    const ids = new Set(servers.map((server) => server.id));
    for (const [id, runtime] of this.runtimes) {
      if (!ids.has(id)) {
        runtime.dispose();
        this.runtimes.delete(id);
      }
    }
    for (const server of servers) {
      const runtime = this.runtimes.get(server.id);
      if (runtime) runtime.applyConfig(server);
      else this.runtimes.set(server.id, new ServerRuntime(server));
    }
  }

  get(id) {
    return this.runtimes.get(id) ?? null;
  }

  all() {
    return [...this.runtimes.values()];
  }

  async shutdown() {
    await Promise.all(
      this.all().map(async (runtime) => {
        try {
          await runtime.stop();
        } catch {
          /* ignora */
        }
        runtime.dispose();
      }),
    );
  }
}

export const runtimeManager = new RuntimeManager();
