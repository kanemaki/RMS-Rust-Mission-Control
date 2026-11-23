export const DISCORD_EVENTS = ['online', 'offline', 'crash', 'wipe', 'backup', 'moderation', 'restart', 'update'];

const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,120}$/;
const COLORS = {
  online: 0x2ecc71,
  offline: 0x95a5a6,
  crash: 0xe74c3c,
  wipe: 0xf39c12,
  backup: 0x3498db,
  moderation: 0xe67e22,
  restart: 0x9b59b6,
  update: 0x1abc9c,
  test: 0x5865f2,
};
const TIMEOUT_MS = 8000;

export function isValidWebhook(url) {
  return WEBHOOK_RE.test(String(url ?? ''));
}

export function defaultDiscord() {
  return {
    enabled: false,
    webhookUrl: '',
    events: { online: true, offline: true, crash: true, wipe: true, backup: false, moderation: true, restart: true, update: true },
  };
}

export function shouldNotify(server, kind) {
  const discord = server?.discord;
  return Boolean(discord?.enabled && discord.webhookUrl && discord.events?.[kind]);
}

export async function sendDiscord(server, kind, { title, description = '' }, fetchImpl = fetch) {
  const url = server?.discord?.webhookUrl;
  if (!isValidWebhook(url)) throw new Error('Webhook do Discord inválido.');
  const body = {
    username: 'Rust Mission Control',
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: String(title).slice(0, 250),
        description: String(description).slice(0, 1800),
        color: COLORS[kind] ?? COLORS.test,
        footer: { text: server.name },
        timestamp: new Date().toISOString(),
      },
    ],
  };
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Discord respondeu HTTP ${res.status}.`);
}

export async function notifyDiscord(server, kind, message, log = () => {}, fetchImpl = fetch) {
  if (!shouldNotify(server, kind)) return;
  try {
    await sendDiscord(server, kind, message, fetchImpl);
  } catch (error) {
    log(`Falha ao enviar alerta ao Discord: ${error.name === 'TimeoutError' ? 'tempo esgotado' : error.message}`);
  }
}
