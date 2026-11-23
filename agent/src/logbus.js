import { EventEmitter } from 'node:events';

/**
 * Barramento de eventos do agente. Cada servidor tem um buffer circular em memória
 * para o console abrir já com contexto, e tudo é replicado via SSE para o painel.
 */
class LogBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.buffers = new Map();
    this.limit = 2000;
  }

  push(serverId, entry) {
    const item = { ts: Date.now(), ...entry };
    let buffer = this.buffers.get(serverId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(serverId, buffer);
    }
    buffer.push(item);
    if (buffer.length > this.limit) buffer.splice(0, buffer.length - this.limit);
    this.emit('event', { type: 'log', serverId, entry: item });
    return item;
  }

  status(serverId, status) {
    this.emit('event', { type: 'status', serverId, status });
  }

  chat(serverId, entry) {
    this.emit('event', { type: 'chat', serverId, entry });
  }

  history(serverId, limit = 300) {
    const buffer = this.buffers.get(serverId) ?? [];
    return buffer.slice(-Math.min(Math.max(limit, 1), this.limit));
  }

  clear(serverId) {
    this.buffers.delete(serverId);
  }
}

export const logBus = new LogBus();
