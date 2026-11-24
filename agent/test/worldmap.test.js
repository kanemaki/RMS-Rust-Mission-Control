import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-worldmap-'));
process.env.RMC_DATA_DIR = dataDir;

const {
  encodePng,
  mapMeta,
  mapPng,
  parseMapName,
  parseWorldMap,
  renderTerrainRgb,
  terrainColor,
  waterColor,
} = await import('../src/worldmap.js');
const {
  clearPositions,
  ingestPositions,
  installLivePlugin,
  liveState,
  pluginSource,
  pluginStatus,
  removeLivePlugin,
  rotateLiveToken,
} = await import('../src/livemap.js');
const { addServer, findServer, loadConfig } = await import('../src/store.js');
const { ValidationError } = await import('../src/errors.js');

const RES = 8;

function varint(value) {
  const bytes = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function field(number, payload) {
  return Buffer.concat([varint(number * 8 + 2), varint(payload.length), payload]);
}

/** Chunk LZ4 não comprimido: flags 0, tamanho descomprimido e os bytes. */
function chunk(payload) {
  return Buffer.concat([varint(0), varint(payload.length), payload]);
}

/** Bloco LZ4 só com literais (sem match), suficiente para exercitar o decoder. */
function lz4LiteralBlock(data) {
  const extra = data.length - 15;
  const parts = [Buffer.from([0xf0])];
  let rest = extra;
  while (rest >= 255) {
    parts.push(Buffer.from([255]));
    rest -= 255;
  }
  parts.push(Buffer.from([rest]), data);
  return Buffer.concat(parts);
}

/** .map sintético: header v10 + chunk LZ4 com o protobuf WorldData. */
function buildMap({ resolution = RES, worldSize = 3000, seed = 1234, water = null } = {}) {
  const cells = resolution * resolution;
  const terrain = Buffer.alloc(cells * 2);
  for (let i = 0; i < cells; i += 1) {
    terrain.writeUInt16LE(1000 + Math.round((i / (cells - 1)) * 20000), i * 2);
  }
  const layers = [Buffer.concat([field(1, Buffer.from('terrain', 'ascii')), field(2, terrain)])];
  if (water) {
    const waterData = Buffer.alloc(cells * 2);
    for (let i = 0; i < cells; i += 1) waterData.writeUInt16LE(water[i] ?? 0, i * 2);
    layers.push(Buffer.concat([field(1, Buffer.from('water', 'ascii')), field(2, waterData)]));
  }
  layers.push(Buffer.concat([field(1, Buffer.from('splat', 'ascii')), field(2, Buffer.alloc(16, 0x11))]));

  const world = Buffer.concat([
    Buffer.concat([varint(1 * 8), varint(worldSize)]),
    ...layers.map((layer) => field(2, layer)),
  ]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(10, 0);
  header.writeBigInt64LE(1_700_000_000_000n, 4);
  return Buffer.concat([header, chunk(world)]);
}

function pngChunks(buffer) {
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    chunks.push({ type, data: buffer.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

test('parseWorldMap descomprime o stream LZ4 e lê as camadas', () => {
  const map = parseWorldMap(buildMap());
  assert.equal(map.version, 10);
  assert.equal(map.worldSize, 3000);
  assert.equal(map.resolution, RES);
  assert.equal(map.terrain.length, RES * RES);
  assert.equal(map.terrain[0], 1000);
  assert.equal(map.terrain[RES * RES - 1], 21000);
  assert.equal(map.water, null);
  assert.deepEqual(
    map.layers.map((layer) => layer.name),
    ['terrain', 'splat'],
  );
  assert.throws(() => parseWorldMap(Buffer.alloc(4)), ValidationError);
  const badVersion = Buffer.alloc(32);
  badVersion.writeUInt32LE(7, 0);
  assert.throws(() => parseWorldMap(badVersion), ValidationError);
});

test('parseWorldMap aceita chunk LZ4 comprimido e camada water', () => {
  const cells = RES * RES;
  const terrain = Buffer.alloc(cells * 2);
  for (let i = 0; i < cells; i += 1) terrain.writeUInt16LE(1000 + i, i * 2);
  const water = Buffer.alloc(cells * 2);
  water.writeUInt16LE(5000, 0);
  const world = Buffer.concat([
    Buffer.concat([varint(8), varint(3000)]),
    field(2, Buffer.concat([field(1, Buffer.from('terrain', 'ascii')), field(2, terrain)])),
    field(2, Buffer.concat([field(1, Buffer.from('water', 'ascii')), field(2, water)])),
  ]);
  const block = lz4LiteralBlock(world);
  const compressed = Buffer.concat([varint(1), varint(world.length), varint(block.length), block]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(10, 0);
  const map = parseWorldMap(Buffer.concat([header, compressed]));
  assert.equal(map.resolution, RES);
  assert.equal(map.terrain[0], 1000);
  assert.equal(map.water[0], 5000);
});

test('parseMapName extrai tamanho, seed e id', () => {
  assert.deepEqual(parseMapName('proceduralmap.3000.292327164.290.map'), {
    worldSize: 3000,
    seed: 292327164,
    mapId: 290,
  });
  assert.equal(parseMapName('outro.map'), null);
});

test('encodePng gera PNG 8-bit RGB válido', () => {
  const rgb = Buffer.alloc(4 * 3 * 3, 0x40);
  const png = encodePng(4, 3, rgb);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = pngChunks(png);
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['IHDR', 'IDAT', 'IEND'],
  );
  assert.equal(chunks[0].data.readUInt32BE(0), 4);
  assert.equal(chunks[0].data.readUInt32BE(4), 3);
  assert.equal(chunks[0].data[8], 8);
  assert.equal(chunks[0].data[9], 2);
  const raw = zlib.inflateSync(chunks[1].data);
  assert.equal(raw.length, (4 * 3 + 1) * 3);
  assert.throws(() => encodePng(2, 2, Buffer.alloc(3)), ValidationError);
});

test('renderTerrainRgb é determinístico e usa a rampa de relevo', () => {
  const map = parseWorldMap(buildMap());
  const first = renderTerrainRgb(map.terrain, map.resolution, 8);
  const second = renderTerrainRgb(map.terrain, map.resolution, 8);
  assert.deepEqual(first, second);
  assert.equal(first.length, 8 * 8 * 3);
  const sand = terrainColor(0);
  const snow = terrainColor(1);
  assert.ok(sand[0] > sand[2], 'areia deve ser quente');
  assert.ok(snow[0] > 200 && snow[1] > 200 && snow[2] > 200, 'neve deve ser clara');
  const shallow = waterColor(0);
  const deep = waterColor(1);
  assert.ok(shallow[2] > shallow[0] && deep[2] > deep[0], 'água deve ser azulada');
  assert.ok(deep[0] < shallow[0], 'água funda deve ser mais escura');
});

test('renderTerrainRgb pinta a camada water de azul', () => {
  const cells = RES * RES;
  const terrain = new Uint16Array(cells).fill(2000);
  const water = new Uint16Array(cells);
  water[0] = 9000;
  const rgb = renderTerrainRgb(terrain, RES, 8, water);
  assert.ok(rgb[2] > rgb[0], 'primeiro pixel deve ser água');
  const land = (7 * 8 + 7) * 3;
  assert.ok(rgb[land + 1] >= rgb[land + 2], 'último pixel deve ser terra');
});

test('mapMeta e mapPng leem o .map do servidor e cacheiam o PNG', () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-install-'));
  const saveDir = path.join(installDir, 'server', 'srv_map');
  fs.mkdirSync(saveDir, { recursive: true });
  fs.writeFileSync(path.join(saveDir, 'proceduralmap.3000.777.290.map'), buildMap({ seed: 777 }));
  const server = addServer({ id: 'srv_map', identity: 'srv_map', installDir, port: 28015, rconPort: 28016 });

  const meta = mapMeta(server);
  assert.equal(meta.available, true);
  assert.equal(meta.seed, 777);
  assert.equal(meta.worldSize, 3000);
  assert.equal(meta.resolution, RES);
  assert.deepEqual(meta.layers, ['terrain', 'splat']);
  assert.equal(meta.water, false);

  const first = mapPng(server);
  assert.equal(first.cached, false);
  assert.equal(first.buffer.subarray(1, 4).toString('ascii'), 'PNG');
  const second = mapPng(server);
  assert.equal(second.cached, true);
  assert.deepEqual(second.buffer, first.buffer);
});

test('mapMeta devolve available:false sem .map', () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-empty-'));
  const server = addServer({ id: 'srv_empty', identity: 'srv_empty', installDir, port: 28017, rconPort: 28018 });
  const meta = mapMeta(server);
  assert.equal(meta.available, false);
  assert.equal(meta.reason, 'missing');
  assert.throws(() => mapPng(server), ValidationError);
});

test('ingestPositions aceita token válido e converte coordenadas', () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-live-'));
  const server = addServer({ id: 'srv_live', identity: 'srv_live', installDir, port: 28019, rconPort: 28020 });
  const token = rotateLiveToken(server.id);
  const now = 1_700_000_000_000;
  const result = ingestPositions({
    token,
    now,
    players: [
      { steamId: '76561198000000001', name: 'Alice', x: 1500, y: 12, z: 750, rot: 90, hp: 100 },
      { steamId: '76561198000000002', name: 'Bob', x: 9999, y: 0, z: 0 },
      { steamId: 'invalido', x: 1, y: 1, z: 1 },
    ],
  });
  assert.equal(result.accepted, 1);
  assert.equal(result.rejected, 2);
  const state = liveState(server.id, { now });
  assert.equal(state.players.length, 1);
  assert.equal(state.players[0].name, 'Alice');
  assert.equal(state.players[0].mx, 0.5);
  assert.equal(state.players[0].my, 0.75);
  assert.equal(state.stale, false);
  assert.equal(liveState(server.id, { now: now + 120_000 }).stale, true);
  clearPositions(server.id);
  assert.equal(liveState(server.id, { now }).players.length, 0);
});

test('ingestPositions recusa token inválido e limita a taxa', () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-rate-'));
  const server = addServer({ id: 'srv_rate', identity: 'srv_rate', installDir, port: 28021, rconPort: 28022 });
  const token = rotateLiveToken(server.id);
  assert.throws(() => ingestPositions({ token: 'x'.repeat(32), players: [] }), (error) => error.status === 401);
  const now = 1_700_000_100_000;
  for (let i = 0; i < 240; i += 1) ingestPositions({ token, players: [], now });
  assert.throws(() => ingestPositions({ token, players: [], now }), (error) => error.status === 429);
  assert.equal(ingestPositions({ token, players: [], now: now + 61_000 }).accepted, 0);
});

test('plugin companion é gerado, instalado e removido', () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-plugin-'));
  const server = addServer({ id: 'srv_plugin', identity: 'srv_plugin', installDir, port: 28023, rconPort: 28024 });
  const source = pluginSource({ agentUrl: 'http://127.0.0.1:8090/', token: 'abc123', intervalSeconds: 5 });
  assert.match(source, /class RmsLiveMap : RustPlugin/);
  assert.match(source, /http:\/\/127\.0\.0\.1:8090\/api\/ingest\/positions/);
  assert.match(source, /Token = "abc123"/);
  assert.match(source, /IntervalSeconds = 5f/);

  const installed = installLivePlugin(server, { agentUrl: 'http://127.0.0.1:8090' });
  assert.equal(installed.installed, true);
  assert.equal(installed.enabled, true);
  assert.ok(fs.existsSync(installed.path));
  const stored = findServer('srv_plugin');
  assert.equal(stored.liveMap.enabled, true);
  assert.match(stored.liveMap.token, /^[A-Za-z0-9_-]{16,128}$/);
  assert.equal(loadConfig().servers.find((item) => item.id === 'srv_plugin').liveMap.intervalSeconds, 5);

  const removed = removeLivePlugin(findServer('srv_plugin'));
  assert.equal(removed.installed, false);
  assert.equal(removed.enabled, false);
  assert.equal(pluginStatus(findServer('srv_plugin')).installed, false);
});
