# Rust Mission Control

🌐 **Português** · [English](README.en.md)

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

- **Instalar/atualizar o Oxide** — baixa a última release do GitHub (`Oxide.Rust.zip` no Windows,
  `Oxide.Rust-linux.zip` no Linux; o nome legado `Oxide-Rust.zip` de releases antigas também é aceito)
  e extrai sobre a pasta do servidor. Exige o servidor parado e verifica a presença de `Oxide.Core.dll` ao final.
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
POST   /api/auth/login               { password } → sessão ou desafio 2FA
POST   /api/auth/login/totp          { challenge, code } → sessão
POST   /api/auth/logout
GET    /api/auth/me                  inclui totpEnabled
GET    /api/auth/totp                status do 2FA e códigos restantes
POST   /api/auth/totp/setup          segredo + otpauth + QR (data URL)
POST   /api/auth/totp/enable         { code } → códigos de recuperação
POST   /api/auth/totp/disable        { password, code }

GET    /api/license                  estado da licença (trial, valid, expired, invalid)
POST   /api/license                  { text } aplica o JSON assinado
DELETE /api/license                  remove a licença aplicada

GET    /api/servers
POST   /api/servers
GET    /api/discover                  pasta padrão sugerida
POST   /api/discover                 { installDir } → identidades e valores do server.cfg

GET    /api/groups                   grupos com contagem de servidores
POST   /api/groups                   { name }
PATCH  /api/groups/:id               { name } (renomear)
DELETE /api/groups/:id               remove o grupo; servidores ficam sem grupo

GET    /api/servers/:id
PATCH  /api/servers/:id
DELETE /api/servers/:id
POST   /api/servers/batch            { ids, action } ação em lote (start/stop/restart/backup)

POST   /api/servers/:id/start        { skipUpdate? }
POST   /api/servers/:id/stop
POST   /api/servers/:id/restart      { skipUpdate? }
POST   /api/servers/:id/update
POST   /api/servers/:id/command      { command }
POST   /api/servers/:id/announce     { message? } envia anúncio agora (rotação se omitido)

GET    /api/servers/:id/logs?limit=
GET    /api/servers/:id/config
PUT    /api/servers/:id/config       { values }
GET    /api/servers/:id/backups
POST   /api/servers/:id/backups      { label? }
POST   /api/servers/:id/backups/:name/restore
DELETE /api/servers/:id/backups/:name
GET    /api/servers/:id/samples?limit=      últimas N amostras cruas
GET    /api/servers/:id/samples?range=24h   séries agregadas (24h, 7d ou 30d)

GET    /api/servers/:id/players?search=     jogadores online e recentes
GET    /api/servers/:id/players/:steamId    perfil, sessões, moderação e nota
PATCH  /api/servers/:id/players/:steamId    { note }
POST   /api/servers/:id/players/:steamId/action  { action, reason?, minutes?, sync? }
GET    /api/servers/:id/moderation?steamId= histórico de moderação
GET    /api/servers/:id/chat?flagged=1      histórico do chat (só sinalizadas com flagged=1)
POST   /api/servers/:id/chat                { message } anúncio no chat via say
GET    /api/servers/:id/chat-filter
PUT    /api/servers/:id/chat-filter         { enabled, keywords, notifyDiscord }
GET    /api/servers/:id/insights?days=30    tempo de jogo, heatmap, ranking e retenção
GET    /api/servers/:id/export/players.csv  jogadores em CSV
GET    /api/servers/:id/export/sessions.csv sessões em CSV

GET    /api/servers/:id/oxide               status do Oxide e contagem de plugins
POST   /api/servers/:id/oxide/install      instala/atualiza o Oxide (servidor parado)
GET    /api/servers/:id/oxide/plugins
POST   /api/servers/:id/oxide/plugins      { url } do uMod ou { name, content }
DELETE /api/servers/:id/oxide/plugins/:name
GET    /api/servers/:id/oxide/plugins/:name/config
PUT    /api/servers/:id/oxide/plugins/:name/config       { raw }
POST   /api/servers/:id/oxide/plugins/:name/load|unload|reload

GET    /api/audit?limit=
GET    /api/events                   SSE (status + logs + chat)
```

O lote (`/api/servers/batch`) executa a ação em paralelo e devolve o resultado por servidor
(`results[].ok`/`error`) — uma falha não derruba as demais. O lote nunca roda a atualização
automática do SteamCMD; para atualizar, use o `update` individual de cada servidor.

## Jogadores, moderação e chat

O agente consulta `playerlist` por RCON em intervalo curto e mantém um registro por servidor:
quem entrou, quando entrou e quando saiu. Cada entrada e saída vira uma sessão, então o painel
mostra o histórico de sessões, a primeira e a última vez de cada jogador e a contagem de mensagens
no chat.

**Moderação** (aba **Jogadores** → perfil): expulsar, banir (com duração opcional em minutos),
desbanir, silenciar e reativar o chat. Toda ação exige o servidor online (RCON conectado), aceita
um motivo e fica registrada no histórico com autor e data. Banir com **sincronizar** aplica o
mesmo ban nos outros servidores do grupo. O painel também aceita uma **nota do admin** por jogador.

**Super usuário** (aba **Jogadores** → perfil → **Tornar super usuário**): concede status de owner
no jogo via `ownerid`, o que libera o F1 e os poderes de admin, como `god` (invencibilidade),
`noclip` e teleporte. O botão vira **Remover super usuário** (`removeowner`) quando o jogador já é
owner, e o estado aparece como selo no perfil. O status é independente de mute e ban: um jogador
pode estar silenciado e continuar como super usuário.

**Chat** (aba **Chat**): as mensagens do jogo são capturadas do console e aparecem ao vivo, com
filtro para ver só as sinalizadas e um campo para enviar anúncios via `say`. O **filtro de chat**
marca mensagens que contenham palavras-chave configuradas (até 50, sem diferenciar maiúsculas) e,
se quiser, avisa no Discord. O evento `moderation` do Discord também pode ser ativado para cada
kick/ban/mute.

Os dados ficam no SQLite do agente (`players`, `player_sessions`, `moderation`, `chat_messages`)
e são limitados por servidor para não crescer sem controle.

## Operação automática

A aba **Automação** do servidor concentra o que roda sozinho, sem clique:

- **Reinício agendado** (servidor local): todos os dias no horário escolhido, com aviso no jogo
  aos 10, 5 e 1 minuto. A opção **só reiniciar se não houver jogadores online** pula o horário
  quando alguém está jogando. Se houver wipe ou atualização em andamento, o reinício é ignorado
  naquele dia em vez de disputar a operação.
- **Atualização agendada** (servidor local): para o servidor, roda o SteamCMD, reinstala o Oxide
  quando ele está instalado e, se **ligar de novo depois de atualizar** estiver marcado, sobe o
  servidor outra vez. Nunca roda junto com um wipe.
- **Anúncios recorrentes**: mensagens enviadas via `say` a cada N minutos (1 a 1440), em rotação,
  até 20 mensagens de 200 caracteres. Funciona também em servidor remoto, porque usa só o RCON.
  O botão **Enviar agora** dispara a próxima mensagem da rotação ou o texto digitado no campo.

O status do servidor expõe `nextRestartAt`, `nextUpdateAt` e `nextAnnouncementAt`, e o painel
mostra a próxima execução de cada um. Os horários usam o fuso local da máquina do agente.

## Inteligência de jogadores

A aba **Inteligência** transforma as sessões já gravadas em números, sem tabela nova:

- **Tempo de jogo** total, hoje, 7 e 30 dias, média por sessão e dias ativos — no painel do
  período e no perfil de cada jogador
- **Heatmap** de dia da semana × hora local, com o tempo distribuído pelas horas que a sessão
  realmente ocupou (uma sessão de 10:00 às 12:00 soma uma hora em cada faixa)
- **Ranking** por tempo de jogo e por número de sessões, com atalho para o perfil
- **Retenção**: novos jogadores, recorrentes e quem sumiu há N dias (padrão 14, ajustável em
  `insights.inactiveDays`)
- **Exportação CSV** de jogadores e sessões, com BOM para abrir direto no Excel

Alertas opcionais no Discord: `player_new` (primeira entrada), `player_inactive` (sumiu há N
dias, checado a cada 6 horas) e `peak` (novo recorde de jogadores online ao mesmo tempo). Todos
vêm desligados por padrão e são ligados em **Ajustes → Discord**.

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
- **2FA (TOTP)** opcional: código de 6 dígitos a cada 30 segundos, tolerância de ±1 passo,
  10 códigos de recuperação de uso único (guardados com hash) e desafio de login válido por 5 minutos
- RCON escuta em `127.0.0.1` e a senha nunca é devolvida pela API
- Processos iniciados com array de argumentos (sem shell), evitando injeção
- CSP, `X-Frame-Options: DENY`, `nosniff` e `no-referrer`
- Auditoria de login, comandos RCON, config, backups e ciclo de vida

### Desativar o 2FA

O 2FA é opcional e pode ser desligado a qualquer momento — não é uma via de mão única.

**Pelo painel (jeito normal):** logado, abra **Segurança** → **Desativar 2FA** e informe a
**senha do painel** mais um **código do autenticador** (ou um dos códigos de recuperação).
A rota é `POST /api/auth/totp/disable { password, code }`. Ao desativar, o segredo, o segredo
pendente e os 10 códigos de recuperação são apagados; se ativar de novo depois, é gerado um
**segredo novo e 10 códigos novos** (os antigos não voltam). O histórico de auditoria
(`totp_enabled` / `totp_disabled`) permanece.

**Saída de emergência (perdeu o celular e os códigos de recuperação):** pare o serviço, edite
`agent/data/config.json` e deixe o bloco `auth.totp` assim, depois suba o serviço de novo:

```json
"totp": {
  "enabled": false,
  "secret": null,
  "pendingSecret": null,
  "recoveryCodes": [],
  "enabledAt": null
}
```

Isso é acesso físico ao arquivo — por isso a pasta `agent/data` não deve ir para repositório
nem para backup público.

> **Por usuário, ainda não.** Hoje o painel tem uma credencial só (um `auth.passwordHash` e um
> `auth.totp` no `config.json`), então desativar vale para o painel inteiro. O 2FA por usuário,
> com o Owner podendo resetar o de um membro específico, entra na **Fase 7 (multi-usuário com papéis)**.

Limitações conhecidas: a senha do RCON fica em texto no `config.json`
(proteja a pasta `agent/data`); o painel não deve ser exposto diretamente na internet sem HTTPS.

## Licença (offline, assinada)

O painel funciona em **período de teste de 14 dias** com todos os recursos liberados. Depois disso,
sem licença, entra em **modo somente leitura**: servidores continuam rodando, console, backups e
restore funcionam; criar, editar e excluir servidores, grupos e plugins fica bloqueado.

A licença é um arquivo JSON assinado com Ed25519 e verificado no próprio agente com a chave pública
embutida em `agent/src/license.js`. **Nenhuma chamada de rede é feita** — não existe servidor de
licenças, phone-home nem revogação online. O arquivo fica em `agent/data/license.json` e também pode
ser colado no painel em **Licença**.

```json
{
  "payload": {
    "v": 1,
    "keyId": "rms-2026",
    "licenseId": "RMS-7F3K-2Q9M",
    "licensee": "Nome do cliente",
    "plan": "pro",
    "maxServers": 10,
    "issuedAt": "2026-11-22T00:00:00.000Z",
    "expiresAt": "2027-11-22T00:00:00.000Z",
    "installId": null
  },
  "signature": "<base64url>"
}
```

- `expiresAt: null` = perpétua; `maxServers: null` = servidores ilimitados
- `installId` fica `null` (licença sem vínculo com máquina); o campo existe para ligar o vínculo no futuro
- Estados: `valid`, `trial`, `expired`, `invalid` e `none` (este último quando `RMC_TRIAL_DAYS=0`)

**Emitir (só o dono do produto):**

```bash
node tools/license-keygen.cjs                 # uma vez; grava a chave privada fora do repositório
node tools/license-issue.cjs --licensee "Fulano" --plan pro --servers 10 --days 365
```

O `license-keygen` grava a chave privada em `%USERPROFILE%\.rms-license\private-key.pem` (ou no
caminho de `--out`/`RMS_LICENSE_KEY`) e imprime a chave pública para colar em `EMBEDDED_PUBLIC_KEY`.
O `license-issue` imprime o JSON no terminal ou grava com `--out`. Sem a chave privada não é possível
emitir licenças — guarde-a fora do repositório e faça backup.

Rotas: `GET /api/license`, `POST /api/license { text }`, `DELETE /api/license`. Aplicar, rejeitar e
remover geram auditoria (`license_applied`, `license_rejected`, `license_removed`).

## Docker

A imagem empacota o painel completo (agente Node.js + interface Angular já compilada).
É o jeito planejado de **entregar o produto**: quem usa não instala Node, apenas roda
`docker compose up -d`.

```bash
docker compose up -d --build   # primeira vez e também para atualizar a imagem
```

Abra `http://localhost:8090` (ou `http://IP-DA-MAQUINA:8090` de outro aparelho) e defina a senha
no primeiro acesso — o `config.json`, o banco SQLite, os logs e a sessão ficam no volume
`rms-data`, então **reconstruir ou atualizar a imagem preserva tudo**.

Comandos do dia a dia:

```bash
docker compose logs -f         # ver o log do agente
docker compose restart         # reiniciar o painel
docker compose down            # parar (dados permanecem no volume)
docker compose up -d --build   # reconstruir depois de baixar código novo
```

**O que funciona dentro do container:** tudo do painel para servidores em modo **remoto** —
console RCON, comandos, contagem de jogadores, cadastro e a interface completa (desktop e celular).

**O que NÃO funciona dentro do container:** servidores em modo **local**. Iniciar o
`RustDedicated.exe`, instalar Oxide/plugins, backups, métricas de CPU/RAM e atualização via
SteamCMD exigem que o agente rode como processo nativo na máquina Windows do servidor do jogo —
um container Linux não inicia processos no hospedeiro. Para esse uso, rode o agente nativo
(`npm start`), instale-o como serviço do Windows (seção anterior) ou os dois; a imagem Docker
serve o painel em modo remoto (RCON) — útil em VPS/NAS e para entregar a ferramenta.

Sem `docker compose`, com `docker` puro:

```bash
docker build -t rms-rust-mission-control .
docker run -d --name rms -p 8090:8090 -v rms-data:/data --restart unless-stopped rms-rust-mission-control
```

## Serviço do Windows (agente)

Para o uso local (servidores com Oxide/plugins na própria máquina), o agente não precisa de
`npm start` a cada boot: ele pode ser registrado como **serviço do Windows** — sobe sozinho
quando o PC liga, não abre janela e volta sozinho se o agente cair.

Em um **PowerShell como Administrador**, dentro de `agent/`:

```powershell
npm install                       # instala as dependências (inclui node-windows)
node service\install-service.cjs  # registra o serviço e já inicia
```

Comandos do dia a dia:

```powershell
Get-Service RMSAgent              # ver o estado do serviço
Start-Service RMSAgent            # iniciar
Stop-Service RMSAgent             # parar (veja o aviso abaixo)
node service\uninstall-service.cjs  # remover o serviço (em PowerShell admin)
```

O log de boot/queda do agente fica em `agent\data\logs\RMSAgent*.log`; os logs de console e
RCON dos servidores continuam em `agent\data\logs\<servidor>\`.

**Aviso: parar o serviço derruba à força os servidores do jogo.** O Windows encerra a árvore
de processos sem o encerramento gracioso por RCON — perde-se o progresso desde o último save
automático. **Pare os servidores pelo painel antes** de parar ou reiniciar o serviço. O
serviço mantém o *painel* no ar; os servidores do jogo continuam sendo iniciados e parados
por você no painel, como sempre.

**Como funciona por dentro:** o pacote `node-windows` grava um wrapper (WinSW) em
`agent\daemon` e o registra como serviço `RMSAgent`. O wrapper vigia o agente
(`node index.js`, que carrega `src/index.js`) e o reinicia com espera crescente se ele cair
(até 10 tentativas em 60 s). O patch `agent\patches\node-windows-fix.cjs` (roda no
`postinstall`) corrige dois defeitos do `node-windows` 1.0.0-beta.8: um `console.log` de
debug e o sufixo `.exe` no nome do serviço.

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
WebSocket falso, ciclo de vida com servidor simulado, grupos e ações em lote, 2FA (TOTP),
licenciamento (assinatura Ed25519, trial, limite de servidores e modo somente leitura), jogadores
(sessões, notas, moderação e expiração de ban), chat (parsing, filtro por palavra-chave e histórico
sinalizado) e um fluxo HTTP completo (setup → login → criar → iniciar → logs → parar). A operação
automática cobre os cálculos de horário, a normalização de reinício/atualização/anúncios, a
validação de modo remoto e o anúncio imediato com rotação contra um RCON falso. A inteligência de
jogadores cobre tempo de jogo, heatmap por hora local, ranking, retenção, inativos e CSV.

## Roadmap

- **Fase 2:** ~~alertas no Discord, backup automático, métricas históricas~~ ✔
- **Fase 3:** ~~plugins Oxide/uMod~~ ✔, ~~multi-servidor avançado (grupos e ações em lote)~~ ✔, ~~2FA (TOTP)~~ ✔, ~~licenciamento~~ ✔
- **Fase 4:** ~~jogadores e sessões~~ ✔, ~~moderação por RCON (kick/ban/mute)~~ ✔, ~~super usuário (owner/unowner)~~ ✔, ~~chat ao vivo e filtro por palavra-chave~~ ✔, ~~ban sincronizado entre servidores do grupo~~ ✔
- **Fase 5:** ~~reinício agendado com avisos~~ ✔, ~~atualização agendada~~ ✔, ~~anúncios recorrentes com rotação~~ ✔
- **Fase 6:** ~~tempo de jogo e heatmap de atividade~~ ✔, ~~ranking e retenção~~ ✔, ~~perfil enriquecido~~ ✔, ~~alertas de jogador novo/inativo/pico~~ ✔, ~~exportação CSV~~ ✔

> Projeto independente, não afiliado à Facepunch Studios. Não redistribui binários do jogo:
> apenas automatiza o SteamCMD.
