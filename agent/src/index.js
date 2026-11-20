import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createApi } from './api.js';
import { loadConfig } from './store.js';
import { runtimeManager } from './process-manager.js';
import { publicDir } from './paths.js';
import { pruneSamples, recordSample } from './db.js';
import { sampleProcess } from './procstats.js';

const PORT = Number(process.env.RMC_PORT) || 8090;
const HOST = process.env.RMC_HOST || '127.0.0.1';
const VERSION = '0.1.0';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'",
  );
  next();
});

app.use(express.json({ limit: '256kb' }));

const secureCookies = process.env.RMC_SECURE_COOKIES === '1';
app.use('/api', createApi({ secureCookies, version: VERSION }));

if (fs.existsSync(publicDir)) {
  app.use(
    express.static(publicDir, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html') || filePath.endsWith('ngsw-worker.js')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res
      .status(503)
      .type('text/plain')
      .send('Painel não compilado. Rode "npm run build" em web/ para gerar agent/public.');
  });
}

app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada.' });
});

runtimeManager.sync(loadConfig().servers);
pruneSamples();

const sampleTimer = setInterval(() => {
  for (const runtime of runtimeManager.all()) {
    if (runtime.state !== 'running') continue;
    const stats = runtime.remote || !runtime.pid ? Promise.resolve(null) : sampleProcess(runtime.pid);
    void stats.then((resources) => {
      recordSample(
        runtime.server.id,
        runtime.state,
        runtime.players,
        resources?.cpu ?? null,
        resources?.mem ?? null,
      );
    });
  }
}, 60000);
sampleTimer.unref();

const server = app.listen(PORT, HOST, () => {
  console.log(`Rust Mission Control ${VERSION}`);
  console.log(`Painel: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (HOST === '0.0.0.0') {
    console.warn('Atenção: escutando em todas as interfaces. Use apenas em rede confiável ou atrás de um túnel/VPN.');
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] encerrando...`);
  clearInterval(sampleTimer);
  server.close();
  await runtimeManager.shutdown();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
