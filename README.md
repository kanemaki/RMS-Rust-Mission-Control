# Rust Mission Control

Painel web local para criar, manter e configurar servidores **Rust Dedicated** no Windows.
Agente em Node.js + interface Angular em PWA (funciona no desktop e no celular).

Esta é a **Fase 1** do projeto: ciclo de vida do servidor, console RCON, editor de `server.cfg`,
backups e atualização via SteamCMD.

## Requisitos

- Windows 10/11
- Node.js 22.5+ (testado com 24)
- SteamCMD — necessário apenas para instalar/atualizar servidores locais
- `tar` no PATH (nativo no Windows 10+)

## Instalação

```bash
npm run install:all
npm run build
npm start
```

Abra `http://127.0.0.1:8090` e defina a senha do painel no primeiro acesso.

Para desenvolvimento com recarga automática do agente:

```bash
npm run dev
```

O painel Angular em modo dev roda separado:

```bash
cd web
npm start
```

## Estrutura

```
agent/                 agente Node (API + processos + RCON)
  src/index.js         bootstrap HTTP, SSE e static do painel
  src/api.js           rotas REST
  src/process-manager.js  ciclo de vida, restart com backoff, logs
  src/rcon.js          cliente WebSocket RCON do Rust
  src/steamcmd.js      install/update do app 258550
  src/cfg.js           schema e leitura/escrita do server.cfg
  src/backups.js       tar.gz da identidade + restore com backup de segurança
  src/auth.js          scrypt, sessões, rate limit
  src/db.js            SQLite nativo (sessões, auditoria, amostras)
  test/                testes unitários, RCON, processo e e2e
web/                   Angular 22 (standalone, signals, PWA)
```

O projeto **não depende** de nenhuma pasta de servidor dentro do repositório. A pasta de instalação e
a do SteamCMD são informadas por servidor e ficam gravadas em `agent/data/config.json`. Se existir uma
instalação em `Rust_Server/Server/rustds` ou `rustds/`, ela é apenas sugerida como caminho padrão.

Dados gerados em `agent/data/`:

- `config.json` — servidores e hash da senha do painel
- `mission-control.db` — sessões, auditoria e amostras de jogadores
- `logs/<id>/` — console do agente e log do Rust
- `backups/<id>/` — arquivos `.tar.gz` da identidade

## O que a Fase 1 faz

- Criar e editar múltiplos servidores (identidade, portas, seed, mapa, jogadores)
- **Adicionar servidor existente**: escaneia a instalação, lista identidades e preenche pelo `server.cfg`
- Modo **remoto**: conecta no RCON de um servidor já em execução em outro host, sem gerenciar processo
- Iniciar, parar e reiniciar com encerramento gracioso via RCON e fallback `taskkill /T`
- Reinício automático com backoff exponencial e limite de 5 tentativas em 10 minutos
- Atualização via SteamCMD com saída ao vivo; falha de update não impede subir a instalação existente
- Console ao vivo (stdout/stderr + RCON + chat) com filtro, autoscroll e comandos
- Editor de `server.cfg` com schema validado, preservando linhas desconhecidas
- Backups manuais da identidade, restore com backup de segurança automático
- Backup automático diário com retenção configurável
- Wipe mensal agendado de mapa, blueprints ou ambos, com backup completo e opção de seed aleatória
- Métricas históricas por servidor: jogadores online, CPU e memória, com gráficos de 24h/7d/30d
- Auditoria de ações e sessões persistidas em SQLite
- PWA instalável, layout responsivo e tema escuro

### Wipe agendado

O wipe é opcional e vem desativado. Para servidores locais gerenciados pelo painel, pode ser agendado
mensalmente entre os dias 1 e 28, no horário local desta máquina. Antes de apagar, o agente cria um
backup completo da identidade e, se o servidor estiver online com RCON conectado, envia avisos RCON aos 10, 5 e 1 minuto.
O wipe de mapa limpa apenas `server/<identidade>/save/`; o de blueprints remove somente os arquivos
`player.blueprints*` da identidade. A seed aleatória é opcional e só se aplica a wipes que incluem o mapa.
Servidores remotos não podem usar essa função. Se o agente estiver desligado na hora marcada, o wipe
não é executado retroativamente: o próximo agendamento será no mês seguinte.

### Backup automático

O backup automático é opcional e vem desativado. Para servidores locais, roda todos os dias no horário
local escolhido e cria um `.tar.gz` completo da identidade (identificado com o sufixo `-scheduled`).
Se o servidor estiver online, o agente pede um `save` via RCON antes de copiar. A retenção mantém apenas
os N backups automáticos mais recentes (1–52); backups manuais, pré-restauração e do wipe agendado nunca
são removidos. Se o agente estiver desligado na hora marcada, o backup não é executado retroativamente.
Há um evento opcional de alerta no Discord para backup concluído ou com falha.

### Métricas históricas

O agente grava uma amostra por minuto de cada servidor em execução: estado, jogadores online (via RCON)
e, para servidores locais, o uso de CPU (segundos acumulados) e a memória RAM do processo. A aba **Métricas**
exibe gráficos de 24 horas, 7 dias ou 30 dias, com pico, média e valor atual, além do limite de jogadores
como referência. Amostras mais antigas que 30 dias são removidas automaticamente. Servidores remotos não
geram amostras de recursos (os arquivos ficam na máquina de origem).

### Plugins (Oxide/uMod)

Para servidores locais, a aba **Plugins (Oxide)** gerencia o Oxide e seus plugins:

- **Instalar/atualizar o Oxide** — baixa a última release (`Oxide-Rust.zip`) do GitHub e extrai sobre a
  pasta do servidor. Exige o servidor parado e verifica a presença de `Oxide.Core.dll` ao final.
- **Lista de plugins** — lê os `.cs` em `Oxide/plugins` e mostra título, autor, versão (do cabeçalho
  `[Info(...)]`) e se o plugin está carregado (via `oxide.plugins` quando o servidor está online).
- **Instalar do uMod** — aceita o nome do plugin ou a URL completa; só `https://umod.org/plugins/Nome.cs`
  é aceito. Também aceita upload de arquivo `.cs`.
- **Config do plugin** — lê e grava `Oxide/config/<Plugin>.json` com validação de JSON.
- **Load / unload / reload** — manda `oxide.load`, `oxide.unload` e `oxide.reload` via RCON com o
  servidor online.

Nomes de plugin são validados contra travessia de caminho, e downloads têm limite de tamanho.

## API

Todas as rotas exigem sessão, exceto `GET /api/health`, `GET /api/setup` e `POST /api/setup`.
Mutações exigem o cabeçalho `x-rmc-request: 1` (proteção CSRF).

```
GET    /api/health
GET    /api/setup
POST   /api/setup                    { password }
POST   /api/auth/login               { password }
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/servers
POST   /api/servers
GET    /api/discover                  pasta padrão sugerida
POST   /api/discover                 { installDir } → identidades e valores do server.cfg
GET    /api/servers/:id
PATCH  /api/servers/:id
DELETE /api/servers/:id

POST   /api/servers/:id/start        { skipUpdate? }
POST   /api/servers/:id/stop
POST   /api/servers/:id/restart      { skipUpdate? }
POST   /api/servers/:id/update
POST   /api/servers/:id/command      { command }

GET    /api/servers/:id/logs?limit=
GET    /api/servers/:id/config
PUT    /api/servers/:id/config       { values }
GET    /api/servers/:id/backups
POST   /api/servers/:id/backups      { label? }
POST   /api/servers/:id/backups/:name/restore
DELETE /api/servers/:id/backups/:name
GET    /api/servers/:id/samples?limit=      últimas N amostras cruas
GET    /api/servers/:id/samples?range=24h   séries agregadas (24h, 7d ou 30d)

GET    /api/servers/:id/oxide               status do Oxide e contagem de plugins
POST   /api/servers/:id/oxide/install      instala/atualiza o Oxide (servidor parado)
GET    /api/servers/:id/oxide/plugins
POST   /api/servers/:id/oxide/plugins      { url } do uMod ou { name, content }
DELETE /api/servers/:id/oxide/plugins/:name
GET    /api/servers/:id/oxide/plugins/:name/config
PUT    /api/servers/:id/oxide/plugins/:name/config       { raw }
POST   /api/servers/:id/oxide/plugins/:name/load|unload|reload

GET    /api/audit?limit=
GET    /api/events                   SSE (status + logs)
```

## Duas formas de cadastrar um servidor

O dashboard tem dois botões separados:

**+ Novo servidor** — cria do zero. O painel instala via SteamCMD, inicia e gerencia o processo
nesta máquina. Você informa identidade, portas, senha RCON, seed e tamanho do mapa.

**Adicionar existente** — registra um servidor que já está instalado e configurado:

- **Nesta máquina:** informe a pasta de instalação e clique em **Escanear**. O agente lê
  `server/*/cfg/server.cfg`, lista as identidades (com indicação de save e cfg) e preenche nome,
  porta do jogo, porta RCON e senha RCON a partir do arquivo existente. Depois escolha como o painel
  deve tratar o servidor:
  - **Já está rodando (conectar via RCON):** conecta no processo em execução sem reiniciá-lo
    (modo `remote` em `127.0.0.1`). Sem start/stop de processo.
  - **O painel inicia e para:** assume o processo (modo `local`), com start, stop e reinício automático.
- **Em outra máquina:** informe host e porta RCON (modo `remote`). Não pede pasta de instalação,
  porque o painel não tem acesso ao disco desse servidor.

A senha RCON é opcional nos dois casos. Deixe vazia se o servidor não usa `rcon.password`; o painel
conecta em `ws://host:porta/`.

Servidores importados entram com `autoUpdate: false`, para o painel não rodar `validate` do SteamCMD
a cada start em uma instalação que você já mantém.

## Servidor remoto (outra máquina)

O agente tem dois modos por servidor:

- **local** — gerencia o processo `RustDedicated.exe` nesta máquina (start/stop/update/backups/config).
- **remote** — conecta apenas no RCON de um servidor que já está rodando em outro host.

Para um servidor remoto, o Rust do outro lado precisa expor o RCON:

```
+rcon.port 28016 +rcon.password "SUA_SENHA" +rcon.web 1
```

E a porta precisa aceitar conexão do seu PC (firewall/security group). No painel, crie o servidor
com tipo **Remoto**, informe o host e a porta RCON, e clique em **Conectar**.

Em modo remoto ficam disponíveis console, comandos e contagem de jogadores. `server.cfg`, backups e
atualização de arquivos retornam 409, porque dependem do disco da máquina de origem.

> RCON do Rust não usa TLS. Evite expor a porta na internet aberta; prefira túnel SSH, VPN
> (Tailscale/WireGuard) ou um proxy com TLS. Se usar túnel SSH, aponte o host para `127.0.0.1`
> e a porta para a porta local encaminhada.

## Acesso pelo celular

Por padrão o agente escuta apenas em `127.0.0.1`. Para acessar na rede local:

```bash
RMC_HOST=0.0.0.0 npm start
```

Para acesso remoto sem abrir porta no roteador, use um túnel (Cloudflare Tunnel, Tailscale ou similar).
Com HTTPS, ative o cookie `Secure`:

```bash
RMC_SECURE_COOKIES=1 npm start
```

Variáveis: `RMC_PORT` (padrão 8090), `RMC_HOST` (padrão 127.0.0.1), `RMC_DATA_DIR`, `RMC_SECURE_COOKIES`.

## Segurança

- Senha do painel com scrypt + salt; sessões opacas com hash SHA-256 no banco
- Cookie `HttpOnly`, `SameSite=Lax`, expiração de 30 dias
- Rate limit de login: 8 tentativas por 15 minutos por IP
- RCON escuta em `127.0.0.1` e a senha nunca é devolvida pela API
- Processos iniciados com array de argumentos (sem shell), evitando injeção
- CSP, `X-Frame-Options: DENY`, `nosniff` e `no-referrer`
- Auditoria de login, comandos RCON, config, backups e ciclo de vida

Limitações conhecidas: sem 2FA ainda; a senha do RCON fica em texto no `config.json`
(proteja a pasta `agent/data`); o painel não deve ser exposto diretamente na internet sem HTTPS.

## Notas de build

O `angular.json` usa `optimization.styles.inlineCritical: false`. O Angular injeta um script inline
para ativar o CSS crítico, e o CSP do agente (`script-src 'self'`) bloqueia scripts inline — sem esse
ajuste o painel carrega sem as classes globais (`.panel`, `.pill`). Se um dia adicionar nonce/hash ao
CSP, pode reativar o `inlineCritical`.

## Testes

```bash
npm test
```

Cobre normalização de config, roundtrip do `server.cfg`, scrypt/sessões, cliente RCON contra um
WebSocket falso, ciclo de vida com servidor simulado e um fluxo HTTP completo
(setup → login → criar → iniciar → logs → parar).

## Roadmap

- **Fase 2:** ~~alertas no Discord, backup automático, métricas históricas~~ ✔
- **Fase 3:** ~~plugins Oxide/uMod~~ ✔, multi-servidor avançado, 2FA (TOTP), licenciamento

> Projeto independente, não afiliado à Facepunch Studios. Não redistribui binários do jogo:
> apenas automatiza o SteamCMD.
