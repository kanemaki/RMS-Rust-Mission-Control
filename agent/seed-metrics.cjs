// Semeia um servidor de demonstração com 24h de amostras realistas em um agente efêmero.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = process.argv[2];
const base = process.argv[3];
if (!dataDir || !base) {
  console.error('uso: node seed-metrics.js <dataDir> <base-url>');
  process.exit(1);
}

async function main() {
  let setupRes = await fetch(`${base}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'demo-metrics-2026' }),
  });
  if (!setupRes.ok && setupRes.status !== 409) throw new Error(`setup: ${setupRes.status} ${await setupRes.text()}`);
  let cookie = (setupRes.headers.get('set-cookie') ?? '').split(';')[0];
  if (!cookie) {
    // Já configurado: fazer login.
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'demo-metrics-2026' }),
    });
    if (!loginRes.ok) throw new Error(`login: ${loginRes.status} ${await loginRes.text()}`);
    cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0];
  }
  if (!cookie) throw new Error('sessão não recebida');

  const createRes = await fetch(`${base}/api/servers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-rmc-request': '1' },
    body: JSON.stringify({
      identity: 'metrics_demo',
      name: 'Kanemaki Server',
      installDir: path.join(dataDir, 'rustds'),
      maxPlayers: 20,
      autoUpdate: false,
      autoRestart: false,
    }),
  });
  if (!createRes.ok) {
    const detail = await createRes.text();
    if (createRes.status !== 400 && createRes.status !== 409) throw new Error(`create: ${createRes.status} ${detail}`);
    console.log('servidor já existe, seguindo:', detail.trim());
  }

  const { getDb } = await import('./src/db.js');
  const db = getDb();
  const existing = db.prepare("SELECT COUNT(*) c FROM samples WHERE server_id = 'metrics_demo'").get();
  if (existing.c > 0) {
    console.log(`amostras já semeadas: ${existing.c}`);
    db.close();
    return;
  }
  const now = Date.now();
  const minute = 60_000;
  const start = now - 24 * 60 * minute;
  const insert = db.prepare('INSERT INTO samples (server_id, ts, state, players, cpu, mem) VALUES (?, ?, ?, ?, ?, ?)');

  // 24h: madrugada vazia, pico no fim da tarde; CPU 8-25%; RAM 3,5GB + leve vazamento.
  let cpuSec = 0;
  let mem = 3.5 * 1024 ** 3;
  db.exec('BEGIN');
  for (let ts = start; ts <= now; ts += minute) {
    const hour = new Date(ts).getHours();
    const gap = hour === 6; // 1h sem amostras (agente desligado): linha some
    if (gap) continue;
    const wave = Math.sin(((hour - 4) / 24) * Math.PI * 2) * 0.5 + 0.5;
    const basePlayers = hour < 7 ? 1 : Math.round(wave * 18);
    const players = Math.max(0, Math.min(20, basePlayers + Math.round(Math.sin(ts / 7e5) * 2)));
    cpuSec += (0.08 + wave * 0.17) * 60 + Math.random() * 2;
    mem += 1.8 * 1024 ** 2 + Math.random() * 1024 ** 2 * 0.4;
    insert.run('metrics_demo', ts, 'running', players, Math.round(cpuSec * 10) / 10, Math.round(mem));
  }
  db.exec('COMMIT');
  const count = db.prepare("SELECT COUNT(*) c FROM samples WHERE server_id = 'metrics_demo'").get();
  console.log(`amostras semeadas: ${count.c}`);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
