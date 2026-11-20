import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ValidationError } from './errors.js';

const execFileAsync = promisify(execFile);

// Nomes de plugin (stem do .cs) — a classe Oxide usa exatamente esse nome
// para o arquivo de config e para os comandos oxide.load/unload/reload.
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,63}$/;
const UMOD_URL_RE = /^https:\/\/umod\.org\/plugins\/([A-Za-z0-9_-]{1,64})\.cs$/;
const MAX_PLUGIN_BYTES = 2 * 1024 * 1024; // .cs de plugin: nenhuma chega perto de 2 MB
const MAX_ZIP_BYTES = 32 * 1024 * 1024; // zip do Oxide fica em torno de 13 MB comprimido
const UMOD_TIMEOUT_MS = 15_000;
const RELEASE_TIMEOUT_MS = 30_000;
const GITHUB_RELEASES = 'https://api.github.com/repos/OxideMod/Oxide.Rust/releases/latest';

const INFO_RE =
  /\[Info\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*(?:"([^"]+)"|([A-Za-z0-9.]+\.[A-Za-z0-9.]+))/;
const DESCRIPTION_RE = /\[Description\(\s*"([^"]*)"/;

export function isUmodUrl(url) {
  return UMOD_URL_RE.test(String(url ?? '').trim());
}

// A uMod publica hoje um zip por plataforma — Oxide.Rust.zip (Windows) e
// Oxide.Rust-linux.zip (Linux) — e antes usava um único Oxide-Rust.zip.
// Escolhemos o anexo da plataforma atual, com fallback para os outros nomes;
// null significa que a release mudou de formato de novo.
export function pickOxideAsset(assets, platform = process.platform) {
  const plain = /^Oxide[.-]?Rust\.zip$/i;
  const linux = /^Oxide[.-]?Rust[.-]?linux\.zip$/i;
  const order = platform === 'win32' ? [plain, linux] : [linux, plain];
  for (const pattern of order) {
    const match = (assets ?? []).find((item) => pattern.test(item?.name ?? ''));
    if (match) return match;
  }
  return null;
}

export function oxideDir(server) {
  return path.join(server.installDir, 'Oxide');
}

export function oxidePluginsDir(server) {
  return path.join(oxideDir(server), 'plugins');
}

export function oxideConfigDir(server) {
  return path.join(oxideDir(server), 'config');
}

// O Oxide é instalado sobrescrevendo DLLs em RustDedicated_Data/Managed.
export function isOxideInstalled(server) {
  return fs.existsSync(path.join(server.installDir, 'RustDedicated_Data', 'Managed', 'Oxide.Core.dll'));
}

/**
 * Aprova um nome de plugin/config resolvido contra a pasta base.
 * Bloqueia travessia de caminho mesmo que um padrão escape por descuido.
 */
function safeName(baseDir, name) {
  const raw = String(name ?? '').trim();
  if (!NAME_RE.test(raw) || raw.includes('..')) {
    throw new ValidationError('Nome de plugin inválido. Use letras, números, ".", "_" ou "-" (até 64 caracteres).');
  }
  const resolved = path.resolve(baseDir, `${raw}.cs`);
  if (resolved !== path.join(baseDir, `${raw}.cs`)) {
    throw new ValidationError('Nome de plugin inválido.');
  }
  return raw;
}

/** Lê o cabeçalho [Info("Título", "Autor", "Versão")] de um plugin C#. */
export function parsePluginHeader(text) {
  const info = INFO_RE.exec(String(text ?? ''));
  if (!info) return null;
  const description = DESCRIPTION_RE.exec(String(text ?? ''));
  return {
    title: info[1].trim(),
    author: info[2].trim(),
    version: (info[3] ?? info[4] ?? '').trim(),
    description: description ? description[1].trim() : '',
  };
}

export function parseRequires(text) {
  const names = [];
  const re = /^\s*\/\/\s*Requires:\s*([A-Za-z0-9_-]{1,64})\s*$/gim;
  let match;
  while ((match = re.exec(String(text ?? '')))) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

export function oxideStatus(server) {
  const pluginsDir = oxidePluginsDir(server);
  const pluginCount = fs.existsSync(pluginsDir)
    ? fs.readdirSync(pluginsDir).filter((file) => file.endsWith('.cs')).length
    : 0;
  return {
    installed: isOxideInstalled(server),
    pluginCount,
    pluginsDir,
  };
}

export function listPlugins(server) {
  const dir = oxidePluginsDir(server);
  if (!fs.existsSync(dir)) return [];
  const configDir = oxideConfigDir(server);
  const plugins = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.cs')) continue;
    const stem = file.slice(0, -3);
    const full = path.join(dir, file);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let header = null;
    let requires = [];
    try {
      const text = fs.readFileSync(full, 'utf8');
      header = parsePluginHeader(text);
      requires = parseRequires(text);
    } catch {
      /* arquivo ilegível: lista mesmo assim */
    }
    plugins.push({
      name: stem,
      title: header?.title || stem,
      author: header?.author ?? '',
      version: header?.version ?? '',
      description: header?.description ?? '',
      sizeBytes: stat.size,
      updatedAt: stat.mtimeMs,
      hasConfig: fs.existsSync(path.join(configDir, `${stem}.json`)),
      missingDependencies: requires.filter((dep) => !fs.existsSync(path.join(dir, `${dep}.cs`))),
    });
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return plugins;
}

function pluginFile(server, name) {
  const dir = oxidePluginsDir(server);
  const stem = safeName(dir, name);
  return { dir, stem, file: path.join(dir, `${stem}.cs`) };
}

/** Grava um .cs recebido (upload ou download do uMod) na pasta de plugins. */
export function savePluginContent(server, name, content) {
  const { stem, file } = pluginFile(server, name);
  const text = String(content ?? '');
  if (!text.trim()) throw new ValidationError('Conteúdo do plugin vazio.');
  if (Buffer.byteLength(text, 'utf8') > MAX_PLUGIN_BYTES) {
    throw new ValidationError('Plugin grande demais (limite de 2 MB).');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  const header = parsePluginHeader(text);
  return { name: stem, title: header?.title || stem };
}

export async function installPluginFromUmod(server, url, depth = 0) {
  const result = await downloadUmodPlugin(server, url);
  const installedDeps = [];
  const failedDeps = [];
  if (depth < 3) {
    const text = fs.readFileSync(pluginFile(server, result.name).file, 'utf8');
    for (const dep of parseRequires(text)) {
      if (fs.existsSync(pluginFile(server, dep).file)) continue;
      try {
        await installPluginFromUmod(server, `https://umod.org/plugins/${dep}.cs`, depth + 1);
        installedDeps.push(dep);
      } catch (error) {
        failedDeps.push({ name: dep, error: error.message });
      }
    }
  }
  return { ...result, installedDeps, failedDeps };
}

async function downloadUmodPlugin(server, url) {
  const match = UMOD_URL_RE.exec(String(url ?? '').trim());
  if (!match) {
    throw new ValidationError('URL inválida. Use um endereço https://umod.org/plugins/Nome.cs.');
  }
  let response;
  try {
    response = await fetch(match[0], {
      signal: AbortSignal.timeout(UMOD_TIMEOUT_MS),
      headers: { 'user-agent': 'rust-mission-control' },
    });
  } catch (error) {
    throw new ValidationError(
      `Falha ao contatar o uMod: ${error?.name === 'TimeoutError' ? 'tempo esgotado.' : error.message}`,
    );
  }
  if (!response.ok) {
    throw new ValidationError(`O uMod respondeu ${response.status} para ${match[0]}. Plugin existe nesse endereço?`);
  }
  const text = await response.text();
  return { ...savePluginContent(server, match[1], text), url: match[0] };
}

export function deletePlugin(server, name) {
  const { file } = pluginFile(server, name);
  if (!fs.existsSync(file)) throw new ValidationError(`Plugin "${name}" não encontrado.`);
  fs.unlinkSync(file);
  return { name };
}

export function pluginConfigPath(server, name) {
  return path.join(oxideConfigDir(server), `${safeName(oxideConfigDir(server), name)}.json`);
}

export function readPluginConfig(server, name) {
  const file = pluginConfigPath(server, name);
  if (!fs.existsSync(file)) return { path: file, exists: false, raw: '' };
  return { path: file, exists: true, raw: fs.readFileSync(file, 'utf8') };
}

/** Grava a config do plugin validando o JSON antes de escrever. */
export function writePluginConfig(server, name, raw) {
  const file = pluginConfigPath(server, name);
  const text = String(raw ?? '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ValidationError(`JSON inválido: ${error.message}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  // O plugin lê a config no load/reload; gravar bonito facilita conferir depois.
  return { path: file, exists: true, raw: `${JSON.stringify(parsed, null, 2)}\n` };
}

/**
 * Melhor esforço para descobrir quais plugins estão carregados via `oxide.plugins`.
 * Qualquer falha devolve um mapa vazio — a lista de arquivos é a fonte da verdade.
 */
export async function detectLoadedPlugins(runtime) {
  try {
    const response = await runtime.command('oxide.plugins');
    const loaded = new Set();
    for (const line of String(response ?? '').split(/\r?\n/)) {
      const match = /^\s{2,}([A-Za-z0-9_. -]+?)\s+v?\d/.exec(line);
      if (match) loaded.add(match[1].trim().toLowerCase());
    }
    return loaded;
  } catch {
    return new Set();
  }
}

/**
 * Instala/atualiza o Oxide baixando o zip da última release e extraindo
 * sobre a pasta do servidor. Exige o servidor parado.
 */
export async function installOrUpdateOxide(server) {
  let release;
  try {
    release = await fetch(GITHUB_RELEASES, {
      signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
      headers: { 'user-agent': 'rust-mission-control', accept: 'application/vnd.github+json' },
    }).then((r) => {
      if (!r.ok) throw new Error(`GitHub respondeu ${r.status}`);
      return r.json();
    });
  } catch (error) {
    throw new ValidationError(
      `Falha ao consultar a release do Oxide: ${error?.name === 'TimeoutError' ? 'tempo esgotado.' : error.message}`,
    );
  }
  const asset = pickOxideAsset(release.assets);
  if (!asset) {
    const names = (release.assets ?? []).map((item) => item?.name).filter(Boolean).join(', ') || 'nenhum anexo';
    throw new ValidationError(
      `Release do Oxide sem o zip esperado (anexos: ${names}). Tente de novo mais tarde.`,
    );
  }
  if ((asset.size ?? 0) > MAX_ZIP_BYTES) throw new ValidationError('Oxide-Rust.zip grande demais; download cancelado.');

  let response;
  try {
    response = await fetch(asset.browser_download_url, {
      signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
      headers: { 'user-agent': 'rust-mission-control' },
    });
  } catch (error) {
    throw new ValidationError(
      `Falha ao baixar o Oxide: ${error?.name === 'TimeoutError' ? 'tempo esgotado.' : error.message}`,
    );
  }
  if (!response.ok) throw new ValidationError(`Download do Oxide falhou (HTTP ${response.status}).`);
  const zip = Buffer.from(await response.arrayBuffer());
  if (zip.length > MAX_ZIP_BYTES) throw new ValidationError('Oxide-Rust.zip grande demais; download cancelado.');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-oxide-'));
  const zipFile = path.join(tmpDir, 'Oxide-Rust.zip');
  try {
    fs.writeFileSync(zipFile, zip);
    if (process.platform === 'win32') {
      // Expand-Archive exige extensão .zip e caminhos absolutos.
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${server.installDir.replace(/'/g, "''")}' -Force`,
      ]);
    } else {
      await execFileAsync('unzip', ['-o', zipFile, '-d', server.installDir]);
    }
  } catch (error) {
    throw new ValidationError(`Falha ao extrair o Oxide: ${error.message}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (!isOxideInstalled(server)) {
    throw new ValidationError(
      'Extração concluída, mas RustDedicated_Data/Managed/Oxide.Core.dll não apareceu. Confira o layout do zip da release.',
    );
  }
  return { version: release.tag_name ?? '', asset: asset.name };
}
