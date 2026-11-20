// RCON falso para testar contagem de jogadores.
// Uso: node test/mock-players.js [porta] [jogadores] [json|texto]
import { WebSocketServer } from 'ws';

const port = Number(process.argv[2]) || 28996;
const total = Number(process.argv[3] ?? 1);
const format = process.argv[4] === 'json' ? 'json' : 'text';

const players = Array.from({ length: total }, (_, index) => ({
  SteamID: `7656119${String(8000000000 + index).padStart(10, '0')}`,
  OwnerSteamID: '0',
  DisplayName: `Jogador${index + 1}`,
  Ping: 20 + index,
  Address: `127.0.0.1:${60000 + index}`,
  EntityId: 100000 + index,
  ConnectedSeconds: 300 + index,
  ViolationLevel: 0,
  CurrentLevel: 0,
  Health: 100,
  Position: { x: 0, y: 0, z: 0 },
  IsMuted: false,
  TeamID: 0,
}));

const wss = new WebSocketServer({ port, path: '/' });

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const isList = /playerlist/i.test(message.Message);
    let body = `ok: ${message.Message}`;
    if (isList) {
      body = format === 'json' ? JSON.stringify(players, null, 2) : `Players: ${total} / 50`;
    }
    socket.send(JSON.stringify({ Identifier: message.Identifier, Message: body, Type: 'Generic', Name: 'Mock' }));
  });
});

console.log(`mock players em ws://127.0.0.1:${port}/ (${total} jogadores, ${format})`);
