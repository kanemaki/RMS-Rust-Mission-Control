import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { RconClient } from '../src/rcon.js';

test('RCON envia comando e recebe resposta pelo identificador', async () => {
  const wss = new WebSocketServer({ port: 0, path: '/senha_teste' });
  await new Promise((resolve) => wss.once('listening', resolve));
  const { port } = wss.address();

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      socket.send(
        JSON.stringify({
          Identifier: message.Identifier,
          Message: 'Players: 2 / 50',
          Type: 'Generic',
          Name: 'Mock',
        }),
      );
    });
  });

  const client = new RconClient({ port, password: 'senha_teste' });
  const connected = new Promise((resolve) => client.once('connection', resolve));
  client.start();
  await connected;

  const response = await client.send('playerlist');
  assert.equal(response, 'Players: 2 / 50');

  client.stop();
  await new Promise((resolve) => wss.close(resolve));
});

test('RCON agrega resposta enviada em múltiplos pacotes', async () => {
  const wss = new WebSocketServer({ port: 0, path: '/senha_teste' });
  await new Promise((resolve) => wss.once('listening', resolve));
  const { port } = wss.address();

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const id = message.Identifier;
      // Rust manda um pacote vazio primeiro e o conteúdo depois.
      socket.send(JSON.stringify({ Identifier: id, Message: '', Type: 'Generic', Name: 'Mock' }));
      socket.send(JSON.stringify({ Identifier: id, Message: 'Players: 1 / 50', Type: 'Generic', Name: 'Mock' }));
    });
  });

  const client = new RconClient({ port, password: 'senha_teste' });
  const connected = new Promise((resolve) => client.once('connection', resolve));
  client.start();
  await connected;

  const response = await client.send('playerlist');
  assert.equal(response, 'Players: 1 / 50');

  client.stop();
  await new Promise((resolve) => wss.close(resolve));
});

test('RCON rejeita comando quando desconectado', async () => {
  const client = new RconClient({ port: 1, password: 'senha_teste' });
  await assert.rejects(() => client.send('status'), /não está conectado/);
});
