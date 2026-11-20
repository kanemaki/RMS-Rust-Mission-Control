import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from './store.js';

export const CONFIG_SCHEMA = [
  { key: 'server.hostname', label: 'Nome do servidor', type: 'string', group: 'Identidade', maxLength: 128 },
  { key: 'server.description', label: 'Descrição', type: 'string', group: 'Identidade', maxLength: 512 },
  { key: 'server.url', label: 'Site / Discord', type: 'string', group: 'Identidade', maxLength: 256 },
  { key: 'server.headerimage', label: 'Imagem de cabeçalho (URL)', type: 'string', group: 'Identidade', maxLength: 512 },
  { key: 'server.logoimage', label: 'Logo (URL)', type: 'string', group: 'Identidade', maxLength: 512 },
  { key: 'server.tags', label: 'Tags', type: 'string', group: 'Identidade', maxLength: 256, hint: 'Separadas por vírgula' },

  { key: 'server.maxplayers', label: 'Máximo de jogadores', type: 'int', group: 'Jogabilidade', min: 1, max: 1000 },
  { key: 'server.pve', label: 'Modo PvE', type: 'bool', group: 'Jogabilidade' },
  { key: 'server.stability', label: 'Estruturas com estabilidade', type: 'bool', group: 'Jogabilidade' },
  { key: 'server.radiation', label: 'Radiação ativa', type: 'bool', group: 'Jogabilidade' },
  { key: 'server.idlekick', label: 'Expulsar inativos (min)', type: 'int', group: 'Jogabilidade', min: 0, max: 1440 },
  { key: 'server.idlekickmode', label: 'Modo de kick por inatividade', type: 'int', group: 'Jogabilidade', min: 0, max: 2 },
  { key: 'server.idlekickadmins', label: 'Kick afeta admins', type: 'bool', group: 'Jogabilidade' },

  { key: 'server.worldsize', label: 'Tamanho do mapa', type: 'int', group: 'Mundo', min: 1000, max: 6000 },
  { key: 'server.seed', label: 'Seed', type: 'int', group: 'Mundo', min: 0, max: 2147483647 },
  { key: 'server.level', label: 'Mapa', type: 'string', group: 'Mundo', maxLength: 64 },
  { key: 'env.time', label: 'Hora do jogo (0-24)', type: 'float', group: 'Mundo', min: 0, max: 24 },
  { key: 'decay.scale', label: 'Escala de decay', type: 'float', group: 'Mundo', min: 0, max: 100 },

  { key: 'server.tickrate', label: 'Tickrate', type: 'int', group: 'Desempenho', min: 10, max: 60 },
  { key: 'server.saveinterval', label: 'Intervalo de save (s)', type: 'int', group: 'Desempenho', min: 30, max: 3600 },
  { key: 'server.antihack', label: 'Anti-cheat do servidor', type: 'bool', group: 'Desempenho' },

  { key: 'server.port', label: 'Porta do jogo', type: 'int', group: 'Rede e RCON', min: 1, max: 65535 },
  { key: 'rcon.port', label: 'Porta RCON', type: 'int', group: 'Rede e RCON', min: 1, max: 65535 },
  { key: 'rcon.password', label: 'Senha RCON', type: 'string', group: 'Rede e RCON', maxLength: 64, secret: true },
  { key: 'rcon.web', label: 'RCON via WebSocket', type: 'bool', group: 'Rede e RCON' },
];

const SCHEMA_BY_KEY = new Map(CONFIG_SCHEMA.map((item) => [item.key, item]));

export function configPath(server) {
  return path.join(server.installDir, 'server', server.identity, 'cfg', 'server.cfg');
}

// O Rust grava sozinho o serverauto.cfg (server.writecfg e save periódico);
// o server.cfg só existe se o painel ou o dono do servidor o criar.
export function autoConfigPath(server) {
  return path.join(server.installDir, 'server', server.identity, 'cfg', 'serverauto.cfg');
}

// Chaves que o painel força na linha de comando (+convar) no boot — o argumento
// sobrescreve os arquivos de cfg, então o cadastro é a fonte real desses valores.
const RECORD_FIELDS = [
  ['server.hostname', 'hostname'],
  ['server.maxplayers', 'maxPlayers'],
  ['server.seed', 'seed'],
  ['server.worldsize', 'worldSize'],
  ['server.saveinterval', 'saveInterval'],
  ['server.port', 'port'],
  ['rcon.port', 'rconPort'],
];

const LAUNCH_FIELDS = [...RECORD_FIELDS, ['rcon.password', 'rconPassword']];

function parseConfigFile(file, collectUnknown) {
  const values = {};
  const unknown = [];
  if (!fs.existsSync(file)) return { values, unknown };
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_.]+)\s+(.*)$/.exec(trimmed);
    if (!match) {
      if (collectUnknown) unknown.push(line);
      continue;
    }
    const [, key, rawValue] = match;
    const value = rawValue.trim().replace(/^"(.*)"$/, '$1');
    if (SCHEMA_BY_KEY.has(key)) values[key] = coerce(value, SCHEMA_BY_KEY.get(key).type);
    else if (collectUnknown) unknown.push(line);
  }
  return { values, unknown };
}

function recordValues(server) {
  const values = {};
  for (const [key, field] of RECORD_FIELDS) {
    const raw = server[field];
    if (raw === undefined || raw === null || raw === '') continue;
    values[key] = coerce(String(raw), SCHEMA_BY_KEY.get(key).type);
  }
  return values;
}

export function readConfig(server) {
  const file = configPath(server);
  const exists = fs.existsSync(file);
  // Mesma ordem de precedência do boot do Rust: serverauto.cfg → server.cfg → argumentos +convar.
  const auto = parseConfigFile(autoConfigPath(server), false);
  const user = exists ? parseConfigFile(file, true) : { values: {}, unknown: [] };
  const values = { ...auto.values, ...user.values, ...recordValues(server) };
  return { path: file, exists, values, unknown: user.unknown, schema: CONFIG_SCHEMA };
}

// Cópia para resposta da API: a senha RCON nunca volta ao painel pela aba server.cfg
// (a fonte real é o cadastro; o discover de importação usa readConfig direto de propósito).
export function withoutSecrets(read) {
  const values = { ...read.values };
  for (const field of CONFIG_SCHEMA) {
    if (field.secret) delete values[field.key];
  }
  return { ...read, values };
}

// Patch para o cadastro a partir dos valores enviados pela aba server.cfg:
// sem isso, o boot aplicaria o +convar antigo e ignoraria o que foi salvo.
export function launchPatch(input) {
  const patch = {};
  if (!input || typeof input !== 'object') return patch;
  for (const [key, field] of LAUNCH_FIELDS) {
    if (!(key in input)) continue;
    const raw = input[key];
    if (raw === '' || raw === null || raw === undefined) continue;
    patch[field] = raw;
  }
  return patch;
}

export function validateValues(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('Valores inválidos.');
  const values = {};
  for (const [key, rawValue] of Object.entries(input)) {
    const field = SCHEMA_BY_KEY.get(key);
    if (!field) throw new ValidationError(`Chave desconhecida: ${key}`);
    const value = validateValue(field, rawValue);
    if (field.secret && value === '') continue;
    values[key] = value;
  }
  return values;
}

export function writeConfig(server, input) {
  const validated = validateValues(input);
  const current = readConfig(server);
  const values = { ...current.values, ...validated };

  const lines = ['// Gerado pelo Rust Mission Control', `// ${new Date().toISOString()}`, ''];
  for (const field of CONFIG_SCHEMA) {
    if (!(field.key in values)) continue;
    lines.push(`${field.key} ${formatValue(values[field.key], field.type)}`);
  }
  if (current.unknown.length) {
    lines.push('', '// Linhas preservadas do arquivo original');
    lines.push(...current.unknown);
  }
  lines.push('');

  const file = configPath(server);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  // Resposta = estado gravado (values é exatamente o que foi escrito no arquivo).
  return { path: file, exists: true, values, unknown: current.unknown, schema: CONFIG_SCHEMA };
}

function validateValue(field, rawValue) {
  if (field.type === 'bool') {
    if (typeof rawValue === 'boolean') return rawValue;
    return ['1', 'true', 'yes', 'on'].includes(String(rawValue).toLowerCase());
  }
  if (field.type === 'int' || field.type === 'float') {
    const num = Number(rawValue);
    if (!Number.isFinite(num)) throw new ValidationError(`${field.label} precisa ser numérico.`);
    if (field.min !== undefined && num < field.min) throw new ValidationError(`${field.label} mínimo: ${field.min}.`);
    if (field.max !== undefined && num > field.max) throw new ValidationError(`${field.label} máximo: ${field.max}.`);
    return field.type === 'int' ? Math.trunc(num) : num;
  }
  const text = String(rawValue ?? '');
  if (field.maxLength && text.length > field.maxLength) {
    throw new ValidationError(`${field.label} aceita no máximo ${field.maxLength} caracteres.`);
  }
  if (/[\r\n"]/.test(text)) throw new ValidationError(`${field.label} não pode conter quebras de linha ou aspas.`);
  return text;
}

function coerce(value, type) {
  if (type === 'bool') return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
  if (type === 'int') return Number.parseInt(value, 10);
  if (type === 'float') return Number.parseFloat(value);
  return value;
}

function formatValue(value, type) {
  if (type === 'bool') return value ? 'true' : 'false';
  if (type === 'int' || type === 'float') return String(value);
  return `"${value}"`;
}
