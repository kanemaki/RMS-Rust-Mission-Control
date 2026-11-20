import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-discord-'));
process.env.RMC_DATA_DIR = dataDir;

const { normalizeServer, publicServer, ValidationError } = await import('../src/store.js');
const { notifyDiscord, sendDiscord } = await import('../src/discord.js');

const URL_OK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789';

function make(discord) {
  return normalizeServer({ identity: 'dc', installDir: path.join(dataDir, 'rustds'), discord });
}

test('discord vem desativado por padrão', () => {
  const server = make();
  assert.equal(server.discord.enabled, false);
  assert.equal(server.discord.webhookUrl, '');
});

test('valida a URL do webhook e exige URL para ativar', () => {
  assert.throws(() => make({ enabled: true }), ValidationError);
  assert.throws(() => make({ webhookUrl: 'https://evil.example/api/webhooks/1/x' }), ValidationError);
  assert.equal(make({ enabled: true, webhookUrl: URL_OK }).discord.webhookUrl, URL_OK);
});

test('webhook em branco preserva o existente e a API nunca o expõe', () => {
  const first = make({ enabled: true, webhookUrl: URL_OK });
  const second = normalizeServer({ discord: { events: { crash: false } } }, first);
  assert.equal(second.discord.webhookUrl, URL_OK);
  assert.equal(second.discord.events.crash, false);
  assert.equal(second.discord.events.online, true);
  const pub = publicServer(second);
  assert.equal(pub.discord.webhookSet, true);
  assert.equal(JSON.stringify(pub).includes('abcdefghijklmnop'), false);
  assert.equal(normalizeServer({ discord: { enabled: false, clearWebhook: true } }, first).discord.webhookUrl, '');
});

test('envia embed ao webhook e respeita eventos desligados', async () => {
  const server = make({ enabled: true, webhookUrl: URL_OK, events: { wipe: false } });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 204 };
  };
  await notifyDiscord(server, 'crash', { title: 'Falha', description: 'x' }, () => {}, fetchImpl);
  await notifyDiscord(server, 'wipe', { title: 'Wipe' }, () => {}, fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, URL_OK);
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  assert.equal(calls[0].body.embeds[0].title, 'Falha');
});

test('falha de envio vira log e não lança', async () => {
  const server = make({ enabled: true, webhookUrl: URL_OK });
  const logs = [];
  await notifyDiscord(server, 'online', { title: 'x' }, (l) => logs.push(l), async () => ({ ok: false, status: 429 }));
  assert.match(logs[0], /429/);
  await assert.rejects(sendDiscord(server, 'test', { title: 'x' }, async () => ({ ok: false, status: 404 })));
});
