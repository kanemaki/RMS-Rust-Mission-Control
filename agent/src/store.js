import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { configFile, ensureDirs, repoRoot } from './paths.js';

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
    autoUpdate: true,
    autoRestart: true,
    extraArgs: [],
  };
}

function defaultConfig() {
  const detected = detectInstall();
  return {
    version: 1,
    auth: { passwordHash: null, salt: null, createdAt: null },
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
    auth: { ...base.auth, ...(raw.auth ?? {}) },
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

function resolveOptionalPath(value) {
  const raw = String(value ?? '').trim();
  return raw ? path.resolve(raw) : '';
}

function clampInt(value, min, max, field) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new ValidationError(`${field} deve ser um número entre ${min} e ${max}.`);
  }
  return num;
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

export function findServer(id) {
  return loadConfig().servers.find((server) => server.id === id) ?? null;
}

export function addServer(input) {
  const config = loadConfig();
  const server = normalizeServer(input);
  if (config.servers.some((item) => item.id === server.id)) {
    throw new ValidationError(`Já existe um servidor com o id "${server.id}".`);
  }
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

export function publicServer(server) {
  const { rconPassword, ...rest } = server;
  return { ...rest, rconPasswordSet: Boolean(rconPassword) };
}
