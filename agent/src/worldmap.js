import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { dataDir } from './paths.js';
import { ValidationError } from './errors.js';

/**
 * Leitura do arquivo .map do Rust e renderização em PNG.
 *
 * Formato (WorldSerialization versão 10): uint32 versão + int64 timestamp e,
 * em seguida, um stream LZ4 em chunks — flags (varint), tamanho descomprimido
 * (varint), tamanho comprimido (varint, só quando comprimido) e os bytes do
 * bloco LZ4. O resultado é o protobuf WorldData: field 1 = tamanho do mundo,
 * field 2 = MapData repetido (field 1 nome, field 2 payload). A camada
 * `terrain` guarda a altura como int16 em 2049x2049 para worldSize 3000, na
 * escala do jogo (BitUtility.Short2Float: valor / 32766).
 */
const HEADER_V9 = 4;
const HEADER_V10 = 12;
const TERRAIN_LAYER = 'terrain';
const WATER_LAYER = 'water';
const DEFAULT_PNG_SIZE = 1024;
/** Muda quando o render muda: invalida PNGs antigos guardados em disco. */
const RENDER_VERSION = 2;
const MAP_NAME_RE = /^proceduralmap\.(\d+)\.(\d+)\.(\d+)\.map$/i;
const SHORT_SCALE = 1 / 32766;

function readVarint(buffer, state) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (state.offset >= buffer.length) throw new ValidationError('Arquivo .map truncado.');
    const byte = buffer[state.offset++];
    result += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return result;
    shift += 7;
    if (shift > 49) throw new ValidationError('Varint inválido no arquivo .map.');
  }
}

/** Bloco LZ4 padrão com tamanho de saída conhecido. */
function lz4Block(src, expected) {
  const out = Buffer.alloc(expected);
  let ip = 0;
  let op = 0;
  while (ip < src.length) {
    const token = src[ip++];
    let literals = token >> 4;
    if (literals === 15) {
      let byte;
      do {
        if (ip >= src.length) throw new ValidationError('Bloco LZ4 truncado.');
        byte = src[ip++];
        literals += byte;
      } while (byte === 255);
    }
    if (ip + literals > src.length || op + literals > expected) {
      throw new ValidationError('Bloco LZ4 com literais além do limite.');
    }
    src.copy(out, op, ip, ip + literals);
    ip += literals;
    op += literals;
    if (ip >= src.length) break;
    if (ip + 2 > src.length) throw new ValidationError('Bloco LZ4 truncado.');
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (offset === 0 || offset > op) throw new ValidationError('Bloco LZ4 com deslocamento inválido.');
    let match = token & 15;
    if (match === 15) {
      let byte;
      do {
        if (ip >= src.length) throw new ValidationError('Bloco LZ4 truncado.');
        byte = src[ip++];
        match += byte;
      } while (byte === 255);
    }
    match += 4;
    if (op + match > expected) throw new ValidationError('Bloco LZ4 maior que o esperado.');
    for (let i = 0; i < match; i += 1) {
      out[op] = out[op - offset];
      op += 1;
    }
  }
  if (op !== expected) throw new ValidationError('Bloco LZ4 incompleto.');
  return out;
}

/** Descomprime o stream LZ4 em chunks do WorldSerialization. */
function decompressWorld(buffer, start) {
  const state = { offset: start };
  const parts = [];
  let total = 0;
  while (state.offset < buffer.length) {
    const flags = readVarint(buffer, state);
    const rawLength = readVarint(buffer, state);
    const compressedLength = flags & 1 ? readVarint(buffer, state) : rawLength;
    if (state.offset + compressedLength > buffer.length) {
      throw new ValidationError('Bloco LZ4 maior que o arquivo.');
    }
    const block = buffer.subarray(state.offset, state.offset + compressedLength);
    state.offset += compressedLength;
    if (flags & 1) {
      if (flags >> 2 !== 0) throw new ValidationError('Bloco LZ4 com múltiplas passagens não é suportado.');
      parts.push(lz4Block(block, rawLength));
    } else {
      if (compressedLength !== rawLength) throw new ValidationError('Bloco LZ4 sem compressão com tamanho divergente.');
      parts.push(Buffer.from(block));
    }
    total += rawLength;
  }
  return Buffer.concat(parts, total);
}

/** Lê o protobuf WorldData e devolve as camadas com seus payloads. */
function parseWorldData(buffer) {
  const state = { offset: 0 };
  const layers = [];
  let worldSize = null;
  while (state.offset < buffer.length) {
    const key = readVarint(buffer, state);
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) {
      const value = readVarint(buffer, state);
      if (field === 1) worldSize = value;
      continue;
    }
    if (wire !== 2) throw new ValidationError('Campo inesperado no .map.');
    const length = readVarint(buffer, state);
    if (state.offset + length > buffer.length) throw new ValidationError('Camada do .map maior que o arquivo.');
    const start = state.offset;
    state.offset += length;
    if (field !== 2) continue;

    const end = start + length;
    const inner = { offset: start };
    let name = null;
    let data = null;
    while (inner.offset < end) {
      const innerKey = readVarint(buffer, inner);
      const innerField = Math.floor(innerKey / 8);
      const innerWire = innerKey & 7;
      if (innerWire === 0) {
        readVarint(buffer, inner);
        continue;
      }
      if (innerWire !== 2) throw new ValidationError('Campo inesperado na camada do .map.');
      const innerLength = readVarint(buffer, inner);
      if (inner.offset + innerLength > end) throw new ValidationError('Camada do .map truncada.');
      const payload = buffer.subarray(inner.offset, inner.offset + innerLength);
      inner.offset += innerLength;
      if (innerField === 1) name = payload.toString('ascii');
      else if (innerField === 2) data = payload;
    }
    if (name && data) layers.push({ name, length: data.length, data });
  }
  return { worldSize, layers };
}

/** Converte um payload de camada em alturas int16 (uint16 LE no arquivo). */
function toHeights(data, layerName) {
  if (data.length % 2 !== 0) throw new ValidationError(`Camada ${layerName} com tamanho ímpar.`);
  const heights = new Uint16Array(data.length / 2);
  for (let i = 0; i < heights.length; i += 1) heights[i] = data.readUInt16LE(i * 2);
  return heights;
}

/** Lê header, descomprime o stream LZ4 e devolve as camadas do .map. */
export function parseWorldMap(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length <= HEADER_V9) {
    throw new ValidationError('Arquivo .map inválido ou vazio.');
  }
  const version = buffer.readUInt32LE(0);
  if (version !== 9 && version !== 10) {
    throw new ValidationError(`Versão de .map não suportada: ${version}.`);
  }
  const header = version === 10 ? HEADER_V10 : HEADER_V9;
  if (buffer.length <= header) throw new ValidationError('Arquivo .map inválido ou vazio.');
  const timestamp = version === 10 ? Number(buffer.readBigInt64LE(4)) : null;

  const world = decompressWorld(buffer, header);
  const parsed = parseWorldData(world);
  const terrainLayer = parsed.layers.find((layer) => layer.name === TERRAIN_LAYER);
  if (!terrainLayer) throw new ValidationError('O arquivo .map não tem camada terrain.');

  const terrain = toHeights(terrainLayer.data, TERRAIN_LAYER);
  const resolution = Math.round(Math.sqrt(terrain.length));
  if (resolution * resolution !== terrain.length) {
    throw new ValidationError('Camada terrain não é quadrada.');
  }
  const waterLayer = parsed.layers.find((layer) => layer.name === WATER_LAYER);
  const water = waterLayer && waterLayer.length === terrainLayer.length
    ? toHeights(waterLayer.data, WATER_LAYER)
    : null;

  return {
    version,
    timestamp,
    worldSize: parsed.worldSize,
    resolution,
    terrain,
    water,
    layers: parsed.layers.map((layer) => ({ name: layer.name, length: layer.length })),
  };
}

/** Extrai seed e worldSize do nome `proceduralmap.<size>.<seed>.<id>.map`. */
export function parseMapName(fileName) {
  const match = MAP_NAME_RE.exec(path.basename(String(fileName ?? '')));
  if (!match) return null;
  return { worldSize: Number(match[1]), seed: Number(match[2]), mapId: Number(match[3]) };
}

/** Pasta de saves do servidor local (`<installDir>/server/<identity>`). */
export function serverSaveDir(server) {
  return path.join(server.installDir, 'server', server.identity);
}

/** .map mais recente da pasta de saves, ou null. */
export function findMapFile(server) {
  if (!server?.installDir) return null;
  const dir = serverSaveDir(server);
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.toLowerCase().endsWith('.map'))
    .map((file) => {
      const full = path.join(dir, file);
      const stat = fs.statSync(full);
      return { file, full, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0] ?? null;
}

const mapCache = new Map();

/** Lê e cacheia o .map por caminho + mtime. */
export function loadWorldMap(filePath, mtimeMs = null) {
  const stat = mtimeMs === null ? fs.statSync(filePath) : { mtimeMs };
  const cached = mapCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.map;
  const map = parseWorldMap(fs.readFileSync(filePath));
  mapCache.set(filePath, { mtimeMs: stat.mtimeMs, map });
  return map;
}

export function clearMapCache() {
  mapCache.clear();
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Codifica RGB (3 bytes por pixel) em PNG de 8 bits, sem dependência. */
export function encodePng(width, height, rgb) {
  if (rgb.length !== width * height * 3) throw new ValidationError('Buffer RGB com tamanho inesperado.');
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Rampa de cor do terreno (0 = mais baixo, 1 = mais alto). */
export function terrainColor(height) {
  const h = Math.min(1, Math.max(0, height));
  if (h < 0.1) return mix([214, 198, 152], [126, 156, 92], h / 0.1);
  if (h < 0.45) return mix([126, 156, 92], [74, 116, 62], (h - 0.1) / 0.35);
  if (h < 0.72) return mix([74, 116, 62], [104, 100, 84], (h - 0.45) / 0.27);
  if (h < 0.9) return mix([104, 100, 84], [150, 146, 138], (h - 0.72) / 0.18);
  return mix([150, 146, 138], [236, 238, 240], (h - 0.9) / 0.1);
}

/** Cor da água: rasa (clara) a funda (escura). */
export function waterColor(depth) {
  const d = Math.min(1, Math.max(0, depth));
  return mix([86, 150, 190], [16, 52, 96], d);
}

function mix(a, b, t) {
  const k = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/**
 * Reduz o terreno para `size`x`size` por média de bloco e aplica sombreamento
 * leve (diferença para o vizinho) para dar relevo. A altura é normalizada pelo
 * mínimo e máximo reais do mapa; células com água na camada `water` viram azul.
 * Determinístico.
 */
export function renderTerrainRgb(terrain, resolution, size = DEFAULT_PNG_SIZE, water = null) {
  if (!terrain?.length || resolution < 2) throw new ValidationError('Terreno inválido para renderização.');
  const out = Buffer.alloc(size * size * 3);
  const scale = resolution / size;
  const heights = new Float32Array(size * size);
  const depths = water ? new Float32Array(size * size) : null;

  let min = 65535;
  let max = 0;
  for (const value of terrain) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = max - min || 1;
  let maxWater = 0;
  if (water) {
    for (const value of water) if (value > maxWater) maxWater = value;
  }

  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * scale);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
      let sum = 0;
      let waterSum = 0;
      let count = 0;
      for (let sy = y0; sy < y1 && sy < resolution; sy += 1) {
        const row = sy * resolution;
        for (let sx = x0; sx < x1 && sx < resolution; sx += 1) {
          sum += terrain[row + sx];
          if (water) waterSum += water[row + sx];
          count += 1;
        }
      }
      const index = y * size + x;
      heights[index] = count ? (sum / count - min) / span : 0;
      if (depths) depths[index] = count && maxWater ? waterSum / count / maxWater : 0;
    }
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x;
      const offset = index * 3;
      if (depths && depths[index] > 0) {
        const [r, g, b] = waterColor(depths[index]);
        out[offset] = Math.round(r);
        out[offset + 1] = Math.round(g);
        out[offset + 2] = Math.round(b);
        continue;
      }
      const h = heights[index];
      const right = heights[y * size + Math.min(size - 1, x + 1)];
      const down = heights[Math.min(size - 1, y + 1) * size + x];
      const shade = 1 + (h - right) * 1.6 + (h - down) * 1.6;
      const [r, g, b] = terrainColor(h);
      out[offset] = Math.max(0, Math.min(255, Math.round(r * shade)));
      out[offset + 1] = Math.max(0, Math.min(255, Math.round(g * shade)));
      out[offset + 2] = Math.max(0, Math.min(255, Math.round(b * shade)));
    }
  }
  return out;
}

export function renderMapPng(terrain, resolution, size = DEFAULT_PNG_SIZE, water = null) {
  return encodePng(size, size, renderTerrainRgb(terrain, resolution, size, water));
}

// ---------------------------------------------------------------- cache em disco

function mapCacheDir() {
  const dir = path.join(dataDir, 'cache', 'maps');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Metadados do mapa do servidor. `pngPath` só existe depois de renderizar.
 * Servidores remotos não têm .map local: devolvem `available: false`.
 */
export function mapMeta(server, { size = DEFAULT_PNG_SIZE } = {}) {
  const found = findMapFile(server);
  if (!found) {
    return {
      available: false,
      reason: server?.mode === 'remote' ? 'remote' : 'missing',
      worldSize: server?.worldSize ?? null,
      seed: server?.seed ?? null,
    };
  }
  const named = parseMapName(found.file);
  const map = loadWorldMap(found.full, found.mtimeMs);
  const worldSize = map.worldSize ?? named?.worldSize ?? server.worldSize;
  return {
    available: true,
    file: found.file,
    bytes: found.size,
    mtime: Math.round(found.mtimeMs),
    seed: named?.seed ?? server.seed,
    worldSize,
    resolution: map.resolution,
    size,
    layers: map.layers.map((layer) => layer.name),
    water: Boolean(map.water),
    bounds: { min: 0, max: worldSize },
  };
}

/** PNG do mapa, com cache em disco invalidado por mtime do .map e versão do render. */
export function mapPng(server, { size = DEFAULT_PNG_SIZE } = {}) {
  const found = findMapFile(server);
  if (!found) throw new ValidationError('Mapa não encontrado para este servidor.');
  const pngPath = path.join(
    mapCacheDir(),
    `${server.id}-${path.basename(found.file, '.map')}-${Math.round(found.mtimeMs)}-${size}-v${RENDER_VERSION}.png`,
  );
  if (fs.existsSync(pngPath)) {
    return { buffer: fs.readFileSync(pngPath), meta: mapMeta(server, { size }), cached: true };
  }
  const map = loadWorldMap(found.full, found.mtimeMs);
  const buffer = renderMapPng(map.terrain, map.resolution, size, map.water);
  fs.writeFileSync(pngPath, buffer);
  return { buffer, meta: mapMeta(server, { size }), cached: false };
}
