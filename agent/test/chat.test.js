import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-chat-'));
process.env.RMC_DATA_DIR = dataDir;

const { formatChat } = await import('../src/process-manager.js');

const chat = (message) => formatChat({ Type: 'Chat', Message: message });

test('extrai usuário e texto do JSON de chat do Rust', () => {
  const payload = JSON.stringify({
    Channel: 2,
    Message: 'Buiuia gave themselves 1000 x Pistol Bullet',
    UserId: '76561198000000000',
    Username: 'Buiuia',
    Color: '#eee',
    Time: 1795123679,
  });
  assert.equal(chat(payload), 'Buiuia: Buiuia gave themselves 1000 x Pistol Bullet');
});

test('chat global vira "usuario: texto"', () => {
  assert.equal(chat(JSON.stringify({ Channel: 0, Message: 'alguem online?', Username: 'Buiuia' })), 'Buiuia: alguem online?');
});

test('sem usuário devolve só o texto', () => {
  assert.equal(chat(JSON.stringify({ Channel: 0, Message: 'oi', Username: '' })), 'oi');
});

test('sem texto devolve só o usuário', () => {
  assert.equal(chat(JSON.stringify({ Channel: 0, Message: '', Username: 'Buiuia' })), 'Buiuia');
});

test('texto puro e JSON inválido passam sem alteração', () => {
  assert.equal(chat('texto puro sem json'), 'texto puro sem json');
  assert.equal(chat('{ json quebrado'), '{ json quebrado');
});

test('objeto já parseado também é aceito', () => {
  assert.equal(chat({ Channel: 0, Message: 'objeto direto', Username: 'Teste' }), 'Teste: objeto direto');
});

test('mensagem ausente não quebra', () => {
  assert.equal(formatChat({ Type: 'Chat' }), '');
  assert.equal(formatChat({ Type: 'Chat', Message: null }), '');
});
