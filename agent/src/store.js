import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { configFile, ensureDirs, repoRoot } from './paths.js';
import { ValidationError } from './errors.js';
import { DISCORD_EVENTS, defaultDiscord, isValidWebhook } from './discord.js';

const IDENTITY_RE = /^[A-Za-z0-9_-]{1,32}$/;

const INSTALL_CANDIDATES = [
  path.join(repoRoot, 'Rust_Server', 'Server', 'rustds'),
  path.join(repoRoot, 'rustds'),
];

/**
 * Procura uma instalação do Rust Dedicated já presente no disco.
 * Retorna null quando nenhum candidato existe, para não gravar caminho inválido.
 */
export function detectInstall() {
  for (const dir of INSTALL_CANDIDATES) {
    if (!fs.existsSync(dir)) continue;
    const steam = path.join(path.dirname(dir), 'steam');
    return { installDir: dir, steamCmdDir: fs.existsSync(steam) ? steam : '' };
  }
  return null;
}

function defaultServer(detected = detectInstall()) {
  return {
    id: 'my_server',
    name: 'Kanemaki Server',
    identity: 'my_server',
    mode: 'local',
    host: '127.0.0.1',
    group: null,
    installDir: detected?.installDir ?? '',
    steamCmdDir: detected?.steamCmdDir ?? '',
    executable: 'RustDedicated.exe',
    executableArgs: [],
    oxide: false,
    port: 28015,
    rconPort: 28016,
    rconPassword: crypto.randomBytes(12).toString('base64url'),
    hostname: 'Kanemaki Server',
    seed: 4365201,
    worldSize: 3000,
    maxPlayers: 50,
    saveInterval: 300,
    startedAtOverride: null,
    wipeSchedule: { enabled: false, dayOfMonth: 1, time: '04:00', type: 'map', rotateSeed: false },
    backupSchedule: { enabled: false, time: '03:00', keep: 7 },
    restartSchedule: { enabled: false, time: '06:00', onlyIfEmpty: false },
    updateSchedule: { enabled: false, time: '05:00', restartAfter: true },
    announcements: { enabled: false, intervalMinutes: 30, messages: [] },
    discord: defaultDiscord(),
    chatFilter: { enabled: false, keywords: [], notifyDiscord: true },
    insights: { inactiveDays: 14 },
    liveMap: { enabled: false, token: null, intervalSeconds: 5 },
    autoUpdate: false,
    autoRestart: true,
    extraArgs: [],
  };
}

function defaultConfig() {
  const detected = detectInstall();
  return {
    version: 1,
    auth: {
      passwordHash: null,
      salt: null,
      createdAt: null,
      totp: { enabled: false, secret: null, pendingSecret: null, recoveryCodes: [], enabledAt: null },
    },
    groups: [],
    servers: detected ? [defaultServer(detected)] : [],
  };
}

let cache = null;

export function loadConfig() {
  if (cache) return cache;
  ensureDirs();
  if (!fs.existsSync(configFile)) {
    cache = defaultConfig();
    saveConfig(cache);
    return cache;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    cache = normalizeConfig(parsed);
  } catch (err) {
    const broken = `${configFile}.broken-${Date.now()}`;
    fs.copyFileSync(configFile, broken);
    cache = defaultConfig();
    saveConfig(cache);
    console.error(`[config] arquivo inválido, cópia salva em ${broken}: ${err.message}`);
  }
  return cache;
}

export function saveConfig(config = cache) {
  ensureDirs();
  const tmp = `${configFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, configFile);
  cache = config;
  return config;
}

export function reloadConfig() {
  cache = null;
  return loadConfig();
}

function normalizeConfig(raw) {
  const base = defaultConfig();
  const config = {
    version: 1,
    auth: {
      ...base.auth,
      ...(raw.auth ?? {}),
      totp: { ...base.auth.totp, ...(raw.auth?.totp ?? {}) },
    },
    groups: Array.isArray(raw.groups) ? raw.groups.map((group) => normalizeGroup(group, group)) : base.groups,
    servers: Array.isArray(raw.servers) ? raw.servers : base.servers,
  };
  config.servers = config.servers.map((server) => normalizeServer(server));
  return config;
}

export function normalizeServer(input, existing = null) {
  const base = existing ?? defaultServer();
  const merged = { ...base, ...input };

  if (!existing) {
    merged.id = String(input.id ?? input.identity ?? '').trim();
  }
  merged.id = String(merged.id || merged.identity || '').trim();
  merged.identity = String(merged.identity || merged.id).trim();
  if (!IDENTITY_RE.test(merged.identity)) {
    throw new ValidationError('identity deve ter de 1 a 32 caracteres: letras, números, "_" ou "-".');
  }
  if (!merged.id) merged.id = merged.identity;
  if (!IDENTITY_RE.test(merged.id)) {
    throw new ValidationError('id deve ter de 1 a 32 caracteres: letras, números, "_" ou "-".');
  }

  merged.mode = merged.mode === 'remote' ? 'remote' : 'local';
  merged.host = String(merged.host || '127.0.0.1').trim();
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(merged.host)) {
    throw new ValidationError('host deve ser um nome de máquina ou IP válido (sem esquema, porta ou barras).');
  }

  merged.group = merged.group === '' ? null : merged.group ?? null;
  if (merged.group !== null) {
    if (typeof merged.group !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(merged.group)) {
      throw new ValidationError('group deve ser o id de um grupo existente.');
    }
  }

  merged.name = String(merged.name || merged.hostname || merged.identity).trim().slice(0, 80);
  merged.hostname = String(merged.hostname || merged.name).trim().slice(0, 128);
  merged.installDir = resolveOptionalPath(merged.installDir);
  merged.steamCmdDir = resolveOptionalPath(merged.steamCmdDir);
  if (merged.mode === 'local' && !merged.installDir) {
    throw new ValidationError('Informe a pasta de instalação do servidor (installDir).');
  }
  merged.executable = String(merged.executable || 'RustDedicated.exe').trim();
  merged.oxide = Boolean(merged.oxide);
  merged.autoUpdate = Boolean(merged.autoUpdate);
  merged.autoRestart = Boolean(merged.autoRestart);

  merged.port = clampInt(merged.port, 1, 65535, 'port');
  merged.rconPort = clampInt(merged.rconPort, 1, 65535, 'rconPort');
  merged.maxPlayers = clampInt(merged.maxPlayers, 1, 1000, 'maxPlayers');
  merged.worldSize = clampInt(merged.worldSize, 1000, 6000, 'worldSize');
  merged.seed = clampInt(merged.seed, 0, 2147483647, 'seed');
  merged.saveInterval = clampInt(merged.saveInterval, 30, 3600, 'saveInterval');

  if (merged.port === merged.rconPort) {
    throw new ValidationError('port e rconPort precisam ser diferentes.');
  }

  merged.rconPassword = String(merged.rconPassword ?? '').trim();
  if (merged.rconPassword && !/^[A-Za-z0-9_-]+$/.test(merged.rconPassword)) {
    throw new ValidationError('rconPassword aceita apenas letras, números, "_" e "-" (sem espaços ou símbolos).');
  }

  merged.startedAtOverride = normalizeTimestamp(merged.startedAtOverride);
  merged.wipeSchedule = normalizeWipeSchedule(merged.wipeSchedule, merged.mode);
  merged.backupSchedule = normalizeBackupSchedule(merged.backupSchedule, merged.mode);
  merged.restartSchedule = normalizeRestartSchedule(merged.restartSchedule, merged.mode);
  merged.updateSchedule = normalizeUpdateSchedule(merged.updateSchedule, merged.mode);
  merged.announcements = normalizeAnnouncements(input.announcements, existing?.announcements ?? merged.announcements);
  merged.discord = normalizeDiscord(input.discord, existing?.discord ?? merged.discord);
  merged.chatFilter = normalizeChatFilter(input.chatFilter, existing?.chatFilter ?? merged.chatFilter);
  merged.insights = normalizeInsights(input.insights, existing?.insights ?? merged.insights);
  merged.liveMap = normalizeLiveMap(input.liveMap, existing?.liveMap ?? merged.liveMap);

  merged.extraArgs = Array.isArray(merged.extraArgs)
    ? merged.extraArgs.map((arg) => String(arg)).filter(Boolean)
    : [];
  merged.executableArgs = Array.isArray(merged.executableArgs)
    ? merged.executableArgs.map((arg) => String(arg)).filter(Boolean)
    : [];

  return merged;
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(num) || num <= 0) {
    throw new ValidationError('startedAtOverride deve ser uma data válida.');
  }
  return Math.trunc(num);
}

function normalizeWipeSchedule(value, mode) {
  const defaults = { enabled: false, dayOfMonth: 1, time: '04:00', type: 'map', rotateSeed: false };
  const schedule = { ...defaults, ...(value && typeof value === 'object' ? value : {}) };
  schedule.enabled = Boolean(schedule.enabled);
  schedule.dayOfMonth = clampInt(schedule.dayOfMonth, 1, 28, 'wipeSchedule.dayOfMonth');
  schedule.time = String(schedule.time ?? '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
    throw new ValidationError('wipeSchedule.time deve estar no formato HH:mm.');
  }
  if (!['map', 'blueprints', 'full'].includes(schedule.type)) {
    throw new ValidationError('wipeSchedule.type deve ser map, blueprints ou full.');
  }
  schedule.rotateSeed = Boolean(schedule.rotateSeed);
  if (schedule.rotateSeed && !['map', 'full'].includes(schedule.type)) {
    throw new ValidationError('A troca de seed exige wipe de mapa.');
  }
  if (schedule.enabled && mode === 'remote') {
    throw new ValidationError('Wipe agendado está disponível apenas para servidores locais.');
  }
  return schedule;
}

function normalizeBackupSchedule(value, mode) {
  const defaults = { enabled: false, time: '03:00', keep: 7 };
  const schedule = { ...defaults, ...(value && typeof value === 'object' ? value : {}) };
  schedule.enabled = Boolean(schedule.enabled);
  schedule.time = String(schedule.time ?? '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
    throw new ValidationError('backupSchedule.time deve estar no formato HH:mm.');
  }
  schedule.keep = clampInt(schedule.keep, 1, 52, 'backupSchedule.keep');
  if (schedule.enabled && mode === 'remote') {
    throw new ValidationError('Backup automático está disponível apenas para servidores locais.');
  }
  return schedule;
}

function normalizeRestartSchedule(value, mode) {
  const defaults = { enabled: false, time: '06:00', onlyIfEmpty: false };
  const schedule = { ...defaults, ...(value && typeof value === 'object' ? value : {}) };
  schedule.enabled = Boolean(schedule.enabled);
  schedule.time = String(schedule.time ?? '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
    throw new ValidationError('restartSchedule.time deve estar no formato HH:mm.');
  }
  schedule.onlyIfEmpty = Boolean(schedule.onlyIfEmpty);
  if (schedule.enabled && mode === 'remote') {
    throw new ValidationError('Reinício agendado está disponível apenas para servidores locais.');
  }
  return schedule;
}

function normalizeUpdateSchedule(value, mode) {
  const defaults = { enabled: false, time: '05:00', restartAfter: true };
  const schedule = { ...defaults, ...(value && typeof value === 'object' ? value : {}) };
  schedule.enabled = Boolean(schedule.enabled);
  schedule.time = String(schedule.time ?? '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
    throw new ValidationError('updateSchedule.time deve estar no formato HH:mm.');
  }
  schedule.restartAfter = Boolean(schedule.restartAfter);
  if (schedule.enabled && mode === 'remote') {
    throw new ValidationError('Atualização agendada está disponível apenas para servidores locais.');
  }
  return schedule;
}

export function normalizeAnnouncements(value, current = null) {
  const base = {
    enabled: false,
    intervalMinutes: 30,
    messages: [],
    ...(current && typeof current === 'object' ? current : {}),
  };
  const input = value && typeof value === 'object' ? value : {};
  const announcements = {
    enabled: input.enabled === undefined ? Boolean(base.enabled) : Boolean(input.enabled),
    intervalMinutes:
      input.intervalMinutes === undefined ? base.intervalMinutes : input.intervalMinutes,
    messages: Array.isArray(input.messages)
      ? input.messages
      : Array.isArray(base.messages)
        ? base.messages
        : [],
  };
  announcements.intervalMinutes = clampInt(
    announcements.intervalMinutes,
    1,
    1440,
    'announcements.intervalMinutes',
  );
  const messages = [];
  for (const item of announcements.messages) {
    const text = String(item ?? '')
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 200);
    if (text) messages.push(text);
    if (messages.length >= 20) break;
  }
  announcements.messages = messages;
  if (announcements.enabled && messages.length === 0) {
    throw new ValidationError('Adicione ao menos uma mensagem para ativar os anúncios automáticos.');
  }
  return announcements;
}

export function normalizeChatFilter(value, current = null) {  const base = current ?? { enabled: false, keywords: [], notifyDiscord: true };
  const input = value && typeof value === 'object' ? value : {};
  const filter = {
    enabled: input.enabled === undefined ? Boolean(base.enabled) : Boolean(input.enabled),
    notifyDiscord:
      input.notifyDiscord === undefined ? Boolean(base.notifyDiscord ?? true) : Boolean(input.notifyDiscord),
    keywords: Array.isArray(input.keywords) ? input.keywords : Array.isArray(base.keywords) ? base.keywords : [],
  };
  const seen = new Set();
  const keywords = [];
  for (const item of filter.keywords) {
    const keyword = String(item ?? '').trim().slice(0, 40);
    if (!keyword) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(keyword);
    if (keywords.length >= 50) break;
  }
  filter.keywords = keywords;
  return filter;
}

export function normalizeInsights(value, current = null) {
  const base = current ?? { inactiveDays: 14 };
  const input = value && typeof value === 'object' ? value : {};
  const inactiveDays =
    input.inactiveDays === undefined ? Number(base.inactiveDays) || 14 : Number(input.inactiveDays);
  return { inactiveDays: clampInt(inactiveDays, 1, 365, 'insights.inactiveDays') };
}

export function normalizeLiveMap(value, current = null) {
  const base = current ?? { enabled: false, token: null, intervalSeconds: 5 };
  const input = value && typeof value === 'object' ? value : {};
  const token = input.token === undefined ? base.token : input.token;
  if (token !== null && (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(token))) {
    throw new ValidationError('liveMap.token inválido.');
  }
  const intervalSeconds =
    input.intervalSeconds === undefined ? Number(base.intervalSeconds) || 5 : Number(input.intervalSeconds);
  return {
    enabled: input.enabled === undefined ? Boolean(base.enabled) : Boolean(input.enabled),
    token: token ?? null,
    intervalSeconds: clampInt(intervalSeconds, 1, 60, 'liveMap.intervalSeconds'),
  };
}

function normalizeDiscord(value, current) {
  const base = { ...defaultDiscord(), ...(current && typeof current === 'object' ? current : {}) };
  const input = value && typeof value === 'object' ? value : {};
  const discord = {
    enabled: input.enabled === undefined ? Boolean(base.enabled) : Boolean(input.enabled),
    webhookUrl: String(base.webhookUrl ?? ''),
    events: { ...defaultDiscord().events, ...(base.events ?? {}) },
  };
  if (typeof input.webhookUrl === 'string' && input.webhookUrl.trim()) {
    discord.webhookUrl = input.webhookUrl.trim();
  }
  if (input.clearWebhook === true) discord.webhookUrl = '';
  for (const key of DISCORD_EVENTS) {
    if (input.events && key in input.events) discord.events[key] = Boolean(input.events[key]);
    discord.events[key] = Boolean(discord.events[key]);
  }
  if (discord.webhookUrl && !isValidWebhook(discord.webhookUrl)) {
    throw new ValidationError('discord.webhookUrl deve ser uma URL de webhook do Discord (https://discord.com/api/webhooks/...).');
  }
  if (discord.enabled && !discord.webhookUrl) {
    throw new ValidationError('Informe a URL do webhook para ativar os alertas do Discord.');
  }
  return discord;
}

function resolveOptionalPath(value) {
  const raw = String(value ?? '').trim();
  return raw ? path.resolve(raw) : '';
}

function normalizeGroup(input, existing = null) {
  const base = existing ?? { id: '', name: '' };
  const group = {
    id: String(base.id ?? ''),
    name: String(input?.name ?? base.name ?? '').trim().slice(0, 64),
  };
  if (!group.name) throw new ValidationError('Informe o nome do grupo.');
  return group;
}

function assertGroupExists(config, groupId) {
  if (groupId && !config.groups.some((group) => group.id === groupId)) {
    throw new ValidationError('Grupo não encontrado.');
  }
}

function clampInt(value, min, max, field) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new ValidationError(`${field} deve ser um número entre ${min} e ${max}.`);
  }
  return num;
}

export { ValidationError };

export function findServer(id) {
  return loadConfig().servers.find((server) => server.id === id) ?? null;
}

export function addServer(input) {
  const config = loadConfig();
  const server = normalizeServer(input);
  if (config.servers.some((item) => item.id === server.id)) {
    throw new ValidationError(`Já existe um servidor com o id "${server.id}".`);
  }
  assertGroupExists(config, server.group);
  config.servers.push(server);
  saveConfig(config);
  return server;
}

export function updateServer(id, patch) {
  const config = loadConfig();
  const index = config.servers.findIndex((server) => server.id === id);
  if (index === -1) return null;
  const current = config.servers[index];
  const next = normalizeServer({ ...patch, id: current.id, identity: patch.identity ?? current.identity }, current);
  assertGroupExists(config, next.group);
  config.servers[index] = next;
  saveConfig(config);
  return next;
}

export function removeServer(id) {
  const config = loadConfig();
  const index = config.servers.findIndex((server) => server.id === id);
  if (index === -1) return false;
  config.servers.splice(index, 1);
  saveConfig(config);
  return true;
}

export function listGroups() {
  const config = loadConfig();
  return config.groups.map((group) => ({
    ...group,
    count: config.servers.filter((server) => server.group === group.id).length,
  }));
}

export function findGroup(id) {
  return loadConfig().groups.find((group) => group.id === id) ?? null;
}

export function addGroup(input) {
  const config = loadConfig();
  const group = normalizeGroup(input);
  if (config.groups.some((item) => item.name.toLowerCase() === group.name.toLowerCase())) {
    throw new ValidationError(`Já existe um grupo chamado "${group.name}".`);
  }
  group.id = crypto.randomUUID();
  config.groups.push(group);
  saveConfig(config);
  return { ...group, count: 0 };
}

export function updateGroup(id, input) {
  const config = loadConfig();
  const index = config.groups.findIndex((group) => group.id === id);
  if (index === -1) return null;
  const next = normalizeGroup({ name: input?.name }, config.groups[index]);
  if (config.groups.some((item) => item.id !== id && item.name.toLowerCase() === next.name.toLowerCase())) {
    throw new ValidationError(`Já existe um grupo chamado "${next.name}".`);
  }
  config.groups[index] = next;
  saveConfig(config);
  return {
    ...next,
    count: config.servers.filter((server) => server.group === next.id).length,
  };
}

export function removeGroup(id) {
  const config = loadConfig();
  const index = config.groups.findIndex((group) => group.id === id);
  if (index === -1) return false;
  config.groups.splice(index, 1);
  for (const server of config.servers) {
    if (server.group === id) server.group = null;
  }
  saveConfig(config);
  return true;
}

export function publicServer(server) {
  const { rconPassword, discord, ...rest } = server;
  const { webhookUrl, ...discordPublic } = discord ?? defaultDiscord();
  return {
    ...rest,
    rconPasswordSet: Boolean(rconPassword),
    discord: { ...discordPublic, webhookSet: Boolean(webhookUrl) },
  };
}
