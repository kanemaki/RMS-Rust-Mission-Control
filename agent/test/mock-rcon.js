// Servidor RCON falso para testar o modo remoto sem um Rust real.
// Uso: node test/mock-rcon.js [porta] [senha]
import { WebSocketServer } from 'ws';

const port = Number(process.argv[2]) || 28990;
const password = process.argv[3] ?? 'senha_remota';

const wss = new WebSocketServer({ port, path: `/${password}` });
wss.on('connection', (socket) => {
  console.log(`cliente conectado em ${port}`);
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const reply = /playerlist/i.test(message.Message) ? 'Players: 7 / 100' : `ok: ${message.Message}`;
    socket.send(JSON.stringify({ Identifier: message.Identifier, Message: reply, Type: 'Generic', Name: 'MockRcon' }));
  });
});
console.log(`mock rcon em ws://127.0.0.1:${port}/${password}`);
