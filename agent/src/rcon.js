import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/** Janela de agregação: o RCON do Rust envia a resposta em vários pacotes. */
const RESPONSE_GRACE_MS = 150;

/**
 * Cliente RCON web do Rust (websocket em ws://host:port/<senha>).
 * Reconecta sozinho enquanto o servidor estiver em execução.
 */
export class RconClient extends EventEmitter {
  constructor({ host = '127.0.0.1', port, password, label = 'rcon' }) {
    super();
    this.host = host;
    this.port = port;
    this.password = password;
    this.label = label;
    this.ws = null;
    this.connected = false;
    this.shouldRun = false;
    this.nextId = 1;
    this.pending = new Map();
    this.retry = 0;
    this.retryTimer = null;
    this.connectTimer = null;
  }

  get url() {
    const secret = encodeURIComponent(this.password ?? '');
    return `ws://${this.host}:${this.port}/${secret}`;
  }

  start() {
    if (this.shouldRun) return;
    this.shouldRun = true;
    this.#connect();
  }

  stop() {
    this.shouldRun = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.connectTimer);
    this.#rejectAll(new Error('RCON encerrado.'));
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignora */
      }
      this.ws = null;
    }
    this.#setConnected(false);
  }

  async send(command, timeoutMs = 15000) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('RCON não está conectado.');
    }
    const identifier = this.nextId++;
    const payload = JSON.stringify({ Identifier: identifier, Message: String(command), Name: 'RustMissionControl' });
    return new Promise((resolve, reject) => {
      const entry = {
        chunks: [],
        graceTimer: null,
        timer: null,
        settled: false,
        resolve: (value) => {
          if (entry.settled) return;
          entry.settled = true;
          clearTimeout(entry.timer);
          clearTimeout(entry.graceTimer);
          this.pending.delete(identifier);
          resolve(value);
        },
        reject: (err) => {
          if (entry.settled) return;
          entry.settled = true;
          clearTimeout(entry.timer);
          clearTimeout(entry.graceTimer);
          this.pending.delete(identifier);
          reject(err);
        },
      };

      entry.timer = setTimeout(() => {
        if (entry.chunks.length) entry.resolve(entry.chunks.join('\n'));
        else entry.reject(new Error(`RCON sem resposta para "${command}" em ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pending.set(identifier, entry);
      this.ws.send(payload, (err) => {
        if (err) entry.reject(err);
      });
    });
  }

  #connect() {
    if (!this.shouldRun) return;
    const ws = new WebSocket(this.url, { handshakeTimeout: 8000 });
    this.ws = ws;

    this.connectTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        try {
          ws.terminate();
        } catch {
          /* ignora */
        }
      }
    }, 9000);

    ws.on('open', () => {
      clearTimeout(this.connectTimer);
      this.retry = 0;
      this.#setConnected(true);
      this.emit('log', { stream: 'rcon', line: 'RCON conectado.' });
    });

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        this.emit('message', { type: 'raw', message: raw.toString() });
        return;
      }
      const pending = message?.Identifier ? this.pending.get(message.Identifier) : null;
      if (pending) {
        const chunk = String(message.Message ?? '');
        if (chunk) pending.chunks.push(chunk);
        clearTimeout(pending.graceTimer);
        pending.graceTimer = setTimeout(() => {
          pending.resolve(pending.chunks.join('\n'));
        }, RESPONSE_GRACE_MS);
        return;
      }
      this.emit('message', message);
    });

    ws.on('error', (err) => {
      // A mensagem do ws inclui a URL com a senha; nunca repassar crua.
      this.emit('log', { stream: 'rcon', line: `RCON erro: ${err.code ?? 'falha de conexão'}` });
    });

    ws.on('close', () => {
      clearTimeout(this.connectTimer);
      this.#setConnected(false);
      this.#rejectAll(new Error('Conexão RCON encerrada.'));
      if (this.shouldRun) this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    clearTimeout(this.retryTimer);
    const delay = Math.min(1000 * 2 ** this.retry, 15000);
    this.retry += 1;
    this.retryTimer = setTimeout(() => this.#connect(), delay);
  }

  #setConnected(value) {
    if (this.connected === value) return;
    this.connected = value;
    this.emit('connection', value);
  }

  #rejectAll(err) {
    for (const [, pending] of this.pending) pending.reject(err);
    this.pending.clear();
  }
}
