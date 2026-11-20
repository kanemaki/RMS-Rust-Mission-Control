/**
 * Interpreta a resposta do comando `playerlist` do Rust.
 *
 * O servidor real responde com um array JSON de objetos de jogador:
 *   [{ "SteamID": "...", "DisplayName": "Buiuia", "Ping": 0, ... }]
 *
 * Algumas builds/plugins respondem em texto ("Players: 1 / 50"), então os dois
 * formatos são aceitos.
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
    };
  }

  const ratio = /(\d+)\s*\/\s*(\d+)/.exec(text);
  if (ratio) {
    return { players: Number(ratio[1]), maxPlayers: Number(ratio[2]), names: [] };
  }

  const steamIds = text.match(/\b7656119\d{10}\b/g);
  if (steamIds) {
    return { players: steamIds.length, maxPlayers: null, names: [] };
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

  const list = Array.isArray(data) ? data : Array.isArray(data?.Players) ? data.Players : null;
  if (!list) return null;

  const names = list
    .map((entry) => String(entry?.DisplayName ?? entry?.Username ?? '').trim())
    .filter(Boolean);

  return { players: list.length, maxPlayers: null, names };
}
