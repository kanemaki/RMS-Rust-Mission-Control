import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from './errors.js';
import { logBus } from './logbus.js';
import { isOxideInstalled, oxidePluginsDir } from './oxide.js';
import { runtimeManager } from './process-manager.js';
import { findServer, loadConfig, updateServer } from './store.js';

/**
 * Mapa ao vivo: o Rust não expõe posições por RCON, então um plugin Oxide
 * companion posta as coordenadas no agente. O token identifica o servidor e
 * é a única credencial aceita na rota pública de ingestão.
 */
export const PLUGIN_NAME = 'RmsLiveMap';
const MAX_PLAYERS = 500;
const MAX_AGE_MS = 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 240;
const STEAM_ID_RE = /^\d{1,20}$/;

const positions = new Map();
const rates = new Map();

export function newLiveToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function sameToken(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function saveLiveMap(server, patch) {
  const updated = updateServer(server.id, {
    liveMap: { ...server.liveMap, ...patch },
  });
  runtimeManager.get(server.id)?.applyConfig(updated);
  return updated;
}

/** Token atual do servidor, criando na primeira vez. */
export function ensureLiveToken(serverId) {
  const server = findServer(serverId);
  if (!server) throw new ValidationError('Servidor não encontrado.');
  if (server.liveMap?.token) return server.liveMap.token;
  const token = newLiveToken();
  saveLiveMap(server, { token });
  return token;
}

/** Gera um token novo; o plugin antigo para de autenticar imediatamente. */
export function rotateLiveToken(serverId) {
  const server = findServer(serverId);
  if (!server) throw new ValidationError('Servidor não encontrado.');
  const token = newLiveToken();
  saveLiveMap(server, { token });
  positions.delete(serverId);
  return token;
}

export function clearPositions(serverId) {
  positions.delete(serverId);
  rates.delete(serverId);
}

function rateLimited(serverId, now) {
  const entry = rates.get(serverId);
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    rates.set(serverId, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_MAX;
}

function sanitizePlayer(raw, worldSize) {
  const steamId = String(raw?.steamId ?? '').trim();
  if (!STEAM_ID_RE.test(steamId)) return null;
  const x = Number(raw?.x);
  const y = Number(raw?.y);
  const z = Number(raw?.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  if (x < 0 || x > worldSize || z < 0 || z > worldSize) return null;
  const rot = Number(raw?.rot);
  const hp = Number(raw?.hp);
  return {
    steamId,
    name: String(raw?.name ?? '').trim().slice(0, 64) || steamId,
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    z: Math.round(z * 100) / 100,
    rot: Number.isFinite(rot) ? Math.round(rot * 10) / 10 : 0,
    hp: Number.isFinite(hp) ? Math.max(0, Math.min(100, Math.round(hp))) : null,
  };
}

/** Estado atual das posições, com fração de mapa pronta para o painel. */
export function liveState(serverId, { now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  const server = findServer(serverId);
  if (!server) throw new ValidationError('Servidor não encontrado.');
  const entry = positions.get(serverId);
  const worldSize = Number(server.worldSize) || 3000;
  const players = entry
    ? [...entry.players.values()].map((player) => ({
        ...player,
        mx: Math.round((player.x / worldSize) * 10000) / 10000,
        my: Math.round((1 - player.z / worldSize) * 10000) / 10000,
      }))
    : [];
  return {
    serverId,
    worldSize,
    at: entry?.at ?? null,
    ageMs: entry ? Math.max(0, now - entry.at) : null,
    stale: entry ? now - entry.at > maxAgeMs : true,
    players,
  };
}

/**
 * Recebe o lote do plugin. Devolve quantos entraram e quantos foram recusados;
 * coordenadas fora dos bounds do mundo são descartadas, não derrubam o lote.
 */
export function ingestPositions({ token, players, now = Date.now() }) {
  const server = loadConfig().servers.find((item) => sameToken(item.liveMap?.token, token));
  if (!server) {
    const error = new ValidationError('Token de ingestão inválido.');
    error.status = 401;
    throw error;
  }
  if (rateLimited(server.id, now)) {
    const error = new ValidationError('Muitas requisições de posição; tente novamente em instantes.');
    error.status = 429;
    throw error;
  }
  if (!Array.isArray(players)) throw new ValidationError('players deve ser uma lista.');
  if (players.length > MAX_PLAYERS) throw new ValidationError(`No máximo ${MAX_PLAYERS} jogadores por lote.`);

  const worldSize = Number(server.worldSize) || 3000;
  const accepted = new Map();
  let rejected = 0;
  for (const raw of players) {
    const player = sanitizePlayer(raw, worldSize);
    if (!player) {
      rejected += 1;
      continue;
    }
    accepted.set(player.steamId, player);
  }

  positions.set(server.id, { at: now, players: accepted });
  const state = liveState(server.id, { now });
  logBus.positions(server.id, state);
  return { serverId: server.id, accepted: accepted.size, rejected, at: now };
}

// ---------------------------------------------------------------- plugin companion

export function pluginPath(server) {
  return path.join(oxidePluginsDir(server), `${PLUGIN_NAME}.cs`);
}

export function pluginStatus(server) {
  const file = pluginPath(server);
  return {
    installed: fs.existsSync(file),
    enabled: Boolean(server.liveMap?.enabled),
    oxide: isOxideInstalled(server),
    token: server.liveMap?.token ?? null,
    intervalSeconds: server.liveMap?.intervalSeconds ?? 5,
    path: file,
  };
}

/** Código C# gerado com a URL do agente e o token já embutidos. */
export function pluginSource({ agentUrl, token, intervalSeconds = 5 }) {
  const url = `${String(agentUrl ?? 'http://127.0.0.1:8090').replace(/\/+$/, '')}/api/ingest/positions`;
  const interval = Math.min(60, Math.max(1, Number(intervalSeconds) || 5));
  return `using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Oxide.Core;
using Oxide.Core.Libraries;
using UnityEngine;

namespace Oxide.Plugins
{
    [Info("RMS Live Map", "RMS Mission Control", "1.0.1")]
    [Description("Envia as posicoes dos jogadores para o painel RMS.")]
    class ${PLUGIN_NAME} : RustPlugin
    {
        private PluginConfig config;
        private Timer sendTimer;

        private class PluginConfig
        {
            [JsonProperty("AgentUrl")] public string AgentUrl = "${url}";
            [JsonProperty("Token")] public string Token = "${token}";
            [JsonProperty("IntervalSeconds")] public float IntervalSeconds = ${interval}f;
        }

        protected override void LoadDefaultConfig()
        {
            Config.WriteObject(new PluginConfig(), true);
        }

        private void Init()
        {
            config = Config.ReadObject<PluginConfig>();
            if (config == null)
            {
                LoadDefaultConfig();
                config = Config.ReadObject<PluginConfig>();
            }
            sendTimer = timer.Every(Mathf.Max(1f, config.IntervalSeconds), SendPositions);
            timer.Once(5f, SendPositions);
        }

        private void Unload()
        {
            sendTimer?.Destroy();
        }

        // Aceita a URL base ou o endpoint completo, sem duplicar o caminho.
        private string Endpoint()
        {
            var url = (config.AgentUrl ?? string.Empty).TrimEnd('/');
            if (url.EndsWith("/api/ingest/positions", StringComparison.OrdinalIgnoreCase)) return url;
            return url + "/api/ingest/positions";
        }

        private void SendPositions()
        {
            var list = new List<object>();
            foreach (var player in BasePlayer.activePlayerList)
            {
                if (player == null || player.IsDead()) continue;
                var position = player.transform.position;
                var rotation = player.eyes != null ? player.eyes.rotation.eulerAngles.y : 0f;
                list.Add(new
                {
                    steamId = player.UserIDString,
                    name = player.displayName,
                    x = Math.Round(position.x, 2),
                    y = Math.Round(position.y, 2),
                    z = Math.Round(position.z, 2),
                    rot = Math.Round(rotation, 1),
                    hp = Mathf.RoundToInt(player.health)
                });
            }
            var body = JsonConvert.SerializeObject(new { players = list });
            var headers = new Dictionary<string, string>
            {
                { "Content-Type", "application/json" },
                { "x-rmc-token", config.Token }
            };
            webrequest.Enqueue(Endpoint(), body, (code, response) =>
            {
                if (code != 200) Puts("RMS: envio de posicoes falhou ({0}) {1}", code, response);
            }, this, RequestMethod.POST, headers, 10f);
        }
    }
}
`;
}

/** Instala/atualiza o plugin na pasta do Oxide e liga o mapa ao vivo. */
export function installLivePlugin(server, { agentUrl, intervalSeconds = 5 } = {}) {
  if (server.mode === 'remote') throw new ValidationError('O plugin companion só pode ser instalado em servidor local.');
  const token = ensureLiveToken(server.id);
  const dir = oxidePluginsDir(server);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pluginPath(server), pluginSource({ agentUrl, token, intervalSeconds }), 'utf8');
  saveLiveMap(server, { enabled: true, token, intervalSeconds });
  return pluginStatus(findServer(server.id));
}

export function removeLivePlugin(server) {
  const file = pluginPath(server);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  saveLiveMap(server, { enabled: false });
  clearPositions(server.id);
  return pluginStatus(findServer(server.id));
}
