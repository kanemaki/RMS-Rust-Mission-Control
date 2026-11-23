/**
 * Interpreta a resposta do comando `playerlist` do Rust.
 *
 * O servidor real responde com um array JSON de objetos de jogador:
 *   [{ "SteamID": "...", "DisplayName": "Buiuia", "Ping": 0, ... }]
 *
 * Algumas builds/plugins respondem em texto ("Players: 1 / 50"), então os dois
 * formatos são aceitos. Quando o JSON traz SteamID, a lista estruturada é
 * devolvida em `list` para o rastreamento de sessões.
 *
 * `structured` diz se a resposta trouxe a lista completa de SteamIDs. Só nesse
 * caso uma lista vazia significa "ninguém online"; nos formatos de texto o
 * total é conhecido mas os jogadores não, então as sessões não podem ser
 * fechadas a partir dela.
 */
export function parsePlayerList(response) {
  const text = String(response ?? '').trim();
  if (!text) return null;

  const fromJson = parseJsonPlayers(text);
  if (fromJson) return fromJson;

  const labelled = /players?\s*[:=]\s*(\d+)\s*(?:\/\s*(\d+))?/i.exec(text);
  if (labelled) {
    return {
      players: Number(labelled[1]),
      maxPlayers: labelled[2] ? Number(labelled[2]) : null,
      names: [],
      list: [],
      structured: false,
    };
  }

  const ratio = /(\d+)\s*\/\s*(\d+)/.exec(text);
  if (ratio) {
    return { players: Number(ratio[1]), maxPlayers: Number(ratio[2]), names: [], list: [], structured: false };
  }

  const steamIds = text.match(/\b7656119\d{10}\b/g);
  if (steamIds) {
    return {
      players: steamIds.length,
      maxPlayers: null,
      names: [],
      list: steamIds.map((steamId) => ({ steamId, name: '', ping: null })),
      structured: true,
    };
  }

  return null;
}

function parseJsonPlayers(text) {
  if (!text.startsWith('[') && !text.startsWith('{')) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }

  const rawList = Array.isArray(data) ? data : Array.isArray(data?.Players) ? data.Players : null;
  if (!rawList) return null;

  const list = rawList
    .map((entry) => {
      const steamId = String(entry?.SteamID ?? entry?.SteamId ?? entry?.UserId ?? '').trim();
      const name = String(entry?.DisplayName ?? entry?.Username ?? '').trim();
      const ping = Number(entry?.Ping);
      return {
        steamId: /^\d{17}$/.test(steamId) ? steamId : null,
        name,
        ping: Number.isFinite(ping) ? ping : null,
      };
    })
    .filter((entry) => entry.steamId || entry.name);

  return {
    players: rawList.length,
    maxPlayers: null,
    names: list.map((entry) => entry.name).filter(Boolean),
    list,
    structured: true,
  };
}
