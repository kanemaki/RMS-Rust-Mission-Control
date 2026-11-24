# Rust Mission Control — imagem do painel (agente + interface compilada)
#
# O que esta imagem faz: sobe o painel web pronto para uso, sem Node instalado
# na máquina. Servidores em modo REMOTO (RCON) funcionam normalmente.
# Servidores em modo LOCAL (RustDedicated.exe, Oxide, backups, SteamCMD) exigem
# o agente nativo na máquina do servidor do jogo — veja a seção Docker do README.

# ---- Estágio 1: compila o painel Angular para agent/public ----
FROM node:22-slim AS web-build
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- Estágio 2: runtime do agente ----
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app

COPY agent/package*.json ./
COPY agent/patches ./patches
RUN npm ci --omit=dev

COPY agent/src ./src
COPY docs/openapi.json ./docs/openapi.json
COPY --from=web-build /build/agent/public ./public

# Dados (config.json com a senha, SQLite, logs, backups) fora do container,
# em volume: recriar/atualizar a imagem preserva tudo.
ENV RMC_DATA_DIR=/data \
    RMC_HOST=0.0.0.0

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RMC_PORT||8090)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
