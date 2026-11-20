// RCON falso que emite uma mensagem de chat do Rust ao conectar.
// Uso: node test/mock-chat.js [porta]
import { WebSocketServer } from 'ws';

const port = Number(process.argv[2]) || 28995;
const wss = new WebSocketServer({ port, path: '/' });

wss.on('connection', (socket) => {
  socket.send(
    JSON.stringify({
      Type: 'Chat',
      Message: JSON.stringify({
        Channel: 2,
        Message: 'Buiuia gave themselves 1000 x Pistol Bullet',
        UserId: '76561198000000000',
        Username: 'Buiuia',
        Color: '#eee',
        Time: 1795123679,
      }),
    }),
  );
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    socket.send(
      JSON.stringify({ Identifier: message.Identifier, Message: 'Players: 1 / 50', Type: 'Generic', Name: 'Mock' }),
    );
  });
});

console.log(`mock chat rcon em ws://127.0.0.1:${port}/`);
