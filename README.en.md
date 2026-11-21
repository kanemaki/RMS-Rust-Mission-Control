# Rust Mission Control

🌐 **English** · [Português](README.md)

> This is a translation of the Portuguese README. In case of divergence, the [Portuguese version](README.md) prevails.

Local web dashboard to create, maintain and configure **Rust Dedicated** servers on Windows.
Node.js agent + Angular interface as a PWA (works on desktop and mobile).

This is **Phase 1** of the project: server lifecycle, RCON console, `server.cfg` editor,
backups and updates via SteamCMD.

## Requirements

- Windows 10/11
- Node.js 22.5+ (tested with 24)
- SteamCMD — only needed to install/update local servers
- `tar` on PATH (native on Windows 10+)

## Setup

```bash
npm run install:all
npm run build
npm start
```

Open `http://127.0.0.1:8090` and set the dashboard password on first access.

For development with agent auto-reload:

```bash
npm run dev
```

The Angular dashboard in dev mode runs separately:

```bash
cd web
npm start
```

## Structure

```
agent/                 Node agent (API + processes + RCON)
  src/index.js         HTTP bootstrap, SSE and dashboard static files
  src/api.js           REST routes
  src/process-manager.js  lifecycle, restart with backoff, logs
  src/rcon.js          Rust WebSocket RCON client
  src/steamcmd.js      install/update for app 258550
  src/cfg.js           server.cfg schema and read/write
  src/backups.js       identity tar.gz + restore with safety backup
  src/auth.js          scrypt, sessions, rate limit
  src/db.js            native SQLite (sessions, audit, samples)
  test/                unit, RCON, process and e2e tests
web/                   Angular 22 (standalone, signals, PWA)
```

The project **does not depend** on any server folder inside the repository. The install folder and
the SteamCMD folder are set per server and stored in `agent/data/config.json`. If an install exists
at `Rust_Server/Server/rustds` or `rustds/`, it is only suggested as the default path.

Data generated in `agent/data/`:

- `config.json` — servers and dashboard password hash
- `mission-control.db` — sessions, audit and player samples
- `logs/<id>/` — agent console and Rust log
- `backups/<id>/` — identity `.tar.gz` files

## What Phase 1 does

- Create and edit multiple servers (identity, ports, seed, map, players)
- **Add existing server**: scans the installation, lists identities and fills fields from `server.cfg`
- **Remote** mode: connects to the RCON of a server already running on another host, without managing the process
- Start, stop and restart with graceful shutdown via RCON and `taskkill /T` fallback
- Automatic restart with exponential backoff, limited to 5 attempts in 10 minutes
- Update via SteamCMD with live output; a failed update does not prevent starting the existing install
- Live console (stdout/stderr + RCON + chat) with filter, autoscroll and commands
- `server.cfg` editor with validated schema, preserving unknown lines
- Manual identity backups, restore with automatic safety backup
- Daily automatic backup with configurable retention
- Scheduled monthly wipe of map, blueprints or both, with full backup and optional random seed
- Historical metrics per server: online players, CPU and memory, with 24h/7d/30d charts
- Audit trail and sessions persisted in SQLite
- Installable PWA, responsive layout and dark theme

### Scheduled wipe

The wipe is optional and comes disabled. For local servers managed by the dashboard, it can be
scheduled monthly between days 1 and 28, at this machine's local time. Before deleting, the agent
creates a full identity backup and, if the server is online with RCON connected, sends RCON warnings
at 10, 5 and 1 minute. The map wipe clears only `server/<identity>/save/`; the blueprint wipe removes
only the identity's `player.blueprints*` files. The random seed is optional and only applies to wipes
that include the map. Remote servers cannot use this feature. If the agent is down at the scheduled
time, the wipe is not run retroactively: the next schedule will be the following month.

### Automatic backup

The automatic backup is optional and comes disabled. For local servers, it runs every day at the
chosen local time and creates a full identity `.tar.gz` (tagged with the `-scheduled` suffix).
If the server is online, the agent requests a `save` via RCON before copying. Retention keeps only
the N most recent automatic backups (1–52); manual, pre-restore and scheduled-wipe backups are never
removed. If the agent is down at the scheduled time, the backup is not run retroactively.
There is an optional Discord webhook alert for completed or failed backups.

### Historical metrics

The agent records one sample per minute for each running server: state, online players (via RCON)
and, for local servers, the process's CPU usage (accumulated seconds) and RAM. The **Metrics** tab
shows 24-hour, 7-day or 30-day charts with peak, average and current values, plus the player limit
as a reference. Samples older than 30 days are removed automatically. Remote servers do not produce
resource samples (those files live on the source machine).

### Plugins (Oxide/uMod)

For local servers, the **Plugins (Oxide)** tab manages Oxide and its plugins:

- **Install/update Oxide** — downloads the latest release from GitHub (`Oxide.Rust.zip` on Windows,
  `Oxide.Rust-linux.zip` on Linux; the legacy `Oxide-Rust.zip` name from older releases is also accepted)
  and extracts it over the server folder. Requires the server to be stopped and verifies the presence
  of `Oxide.Core.dll` at the end.
- **Plugin list** — reads the `.cs` files in `Oxide/plugins` and shows title, author, version (from the
  `[Info(...)]` header) and whether the plugin is loaded (via `oxide.plugins` when the server is online).
- **Install from uMod** — accepts the plugin name or the full URL; only `https://umod.org/plugins/Name.cs`
  is accepted. Also accepts a `.cs` file upload.
- **Plugin config** — reads and writes `Oxide/config/<Plugin>.json` with JSON validation.
- **Load / unload / reload** — sends `oxide.load`, `oxide.unload` and `oxide.reload` via RCON with the
  server online.

Plugin names are validated against path traversal, and downloads have a size limit.

## API

All routes require a session, except `GET /api/health`, `GET /api/setup` and `POST /api/setup`.
Mutations require the `x-rmc-request: 1` header (CSRF protection).

```
GET    /api/health
GET    /api/setup
POST   /api/setup                    { password }
POST   /api/auth/login               { password }
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/servers
POST   /api/servers
GET    /api/discover                  suggested default folder
POST   /api/discover                 { installDir } → identities and server.cfg values
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
GET    /api/servers/:id/samples?limit=      last N raw samples
GET    /api/servers/:id/samples?range=24h   aggregated series (24h, 7d or 30d)

GET    /api/servers/:id/oxide               Oxide status and plugin count
POST   /api/servers/:id/oxide/install      installs/updates Oxide (server stopped)
GET    /api/servers/:id/oxide/plugins
POST   /api/servers/:id/oxide/plugins      { url } from uMod or { name, content }
DELETE /api/servers/:id/oxide/plugins/:name
GET    /api/servers/:id/oxide/plugins/:name/config
PUT    /api/servers/:id/oxide/plugins/:name/config       { raw }
POST   /api/servers/:id/oxide/plugins/:name/load|unload|reload

GET    /api/audit?limit=
GET    /api/events                   SSE (status + logs)
```

## Two ways to register a server

The dashboard has two separate buttons:

**+ New server** — creates one from scratch. The dashboard installs it via SteamCMD, starts it and
manages the process on this machine. You provide identity, ports, RCON password, seed and map size.

**Add existing** — registers a server that is already installed and configured:

- **On this machine:** provide the install folder and click **Scan**. The agent reads
  `server/*/cfg/server.cfg`, lists the identities (indicating save and cfg) and fills in the name,
  game port, RCON port and RCON password from the existing file. Then choose how the dashboard
  should handle the server:
  - **Already running (connect via RCON):** connects to the running process without restarting it
    (`remote` mode on `127.0.0.1`). No process start/stop.
  - **The dashboard starts and stops it:** takes over the process (`local` mode), with start, stop
    and automatic restart.
- **On another machine:** provide the host and RCON port (`remote` mode). No install folder required,
  because the dashboard has no access to that server's disk.

The RCON password is optional in both cases. Leave it empty if the server does not use
`rcon.password`; the dashboard connects to `ws://host:port/`.

Imported servers start with `autoUpdate: false`, so the dashboard does not run SteamCMD `validate`
on every start of an install you already maintain.

## Remote server (another machine)

The agent has two modes per server:

- **local** — manages the `RustDedicated.exe` process on this machine (start/stop/update/backups/config).
- **remote** — only connects to the RCON of a server already running on another host.

For a remote server, the Rust instance on the other side needs to expose RCON:

```
+rcon.port 28016 +rcon.password "YOUR_PASSWORD" +rcon.web 1
```

And the port must accept connections from your PC (firewall/security group). On the dashboard, create
the server with type **Remote**, provide the host and RCON port, and click **Connect**.

In remote mode, console, commands and player count are available. `server.cfg`, backups and file
updates return 409, because they depend on the source machine's disk.

> Rust RCON does not use TLS. Avoid exposing the port on the open internet; prefer an SSH tunnel, VPN
> (Tailscale/WireGuard) or a TLS proxy. If you use an SSH tunnel, point the host to `127.0.0.1`
> and the port to the forwarded local port.

## Mobile access

By default the agent listens only on `127.0.0.1`. To access it on the local network:

```bash
RMC_HOST=0.0.0.0 npm start
```

For remote access without opening a router port, use a tunnel (Cloudflare Tunnel, Tailscale or similar).
With HTTPS, enable the `Secure` cookie:

```bash
RMC_SECURE_COOKIES=1 npm start
```

Variables: `RMC_PORT` (default 8090), `RMC_HOST` (default 127.0.0.1), `RMC_DATA_DIR`, `RMC_SECURE_COOKIES`.

## Security

- Dashboard password with scrypt + salt; opaque sessions with SHA-256 hash in the database
- `HttpOnly` cookie, `SameSite=Lax`, 30-day expiry
- Login rate limit: 8 attempts per 15 minutes per IP
- RCON listens on `127.0.0.1` and the password is never returned by the API
- Processes started with an argument array (no shell), avoiding injection
- CSP, `X-Frame-Options: DENY`, `nosniff` and `no-referrer`
- Audit of logins, RCON commands, config, backups and lifecycle

Known limitations: no 2FA yet; the RCON password is stored in plain text in `config.json`
(protect the `agent/data` folder); the dashboard should not be exposed directly to the internet
without HTTPS.

## Docker

The image packages the full dashboard (Node.js agent + already-built Angular interface).
It is the planned way to **deliver the product**: users do not install Node, they just run
`docker compose up -d`.

```bash
docker compose up -d --build   # first time and also to update the image
```

Open `http://localhost:8090` (or `http://MACHINE-IP:8090` from another device) and set the password
on first access — `config.json`, the SQLite database, logs and sessions live in the `rms-data`
volume, so **rebuilding or updating the image preserves everything**.

Day-to-day commands:

```bash
docker compose logs -f         # follow the agent log
docker compose restart         # restart the dashboard
docker compose down            # stop (data stays in the volume)
docker compose up -d --build   # rebuild after pulling new code
```

**What works inside the container:** everything for servers in **remote** mode —
RCON console, commands, player count, server registration and the full interface (desktop and mobile).

**What does NOT work inside the container:** servers in **local** mode. Starting
`RustDedicated.exe`, installing Oxide/plugins, backups, CPU/RAM metrics and SteamCMD updates require
the agent to run as a native process on the game server's Windows machine — a Linux container cannot
start processes on the host. For that use, run the native agent (`npm start`), install it as a Windows
service (previous section) or both; the Docker image serves the dashboard in remote mode (RCON) —
useful on VPS/NAS and for delivering the tool.

Without `docker compose`, with plain `docker`:

```bash
docker build -t rms-rust-mission-control .
docker run -d --name rms -p 8090:8090 -v rms-data:/data --restart unless-stopped rms-rust-mission-control
```

## Windows service (agent)

For local use (servers with Oxide/plugins on your own machine), the agent does not need
`npm start` on every boot: it can be registered as a **Windows service** — it starts by itself
when the PC boots, opens no window and comes back on its own if the agent crashes.

In a **PowerShell as Administrator**, inside `agent/`:

```powershell
npm install                       # installs dependencies (includes node-windows)
node service\install-service.cjs  # registers the service and starts it
```

Day-to-day commands:

```powershell
Get-Service RMSAgent              # check the service state
Start-Service RMSAgent            # start
Stop-Service RMSAgent             # stop (see the warning below)
node service\uninstall-service.cjs  # remove the service (in admin PowerShell)
```

The agent boot/crash log lives in `agent\data\logs\RMSAgent*.log`; server console and RCON logs
remain in `agent\data\logs\<server>\`.

**Warning: stopping the service force-kills the game servers.** Windows terminates the process tree
without the graceful RCON shutdown — progress since the last automatic save is lost. **Stop the game
servers from the dashboard before** stopping or restarting the service. The service keeps the
*dashboard* up; game servers are still started and stopped by you in the dashboard, as always.

**How it works under the hood:** the `node-windows` package writes a wrapper (WinSW) to
`agent\daemon` and registers it as the `RMSAgent` service. The wrapper watches the agent
(`node index.js`, which loads `src/index.js`) and restarts it with increasing backoff if it crashes
(up to 10 attempts in 60 s). The `agent\patches\node-windows-fix.cjs` patch (runs on `postinstall`)
fixes two defects of `node-windows` 1.0.0-beta.8: a leftover debug `console.log` and the `.exe`
suffix in the service name.

## Build notes

`angular.json` uses `optimization.styles.inlineCritical: false`. Angular injects an inline script to
enable critical CSS, and the agent's CSP (`script-src 'self'`) blocks inline scripts — without this
adjustment the dashboard loads without global classes (`.panel`, `.pill`). If you ever add nonce/hash
to the CSP, you can re-enable `inlineCritical`.

## Tests

```bash
npm test
```

Covers config normalization, `server.cfg` roundtrip, scrypt/sessions, the RCON client against a fake
WebSocket, the process lifecycle with a simulated server, and a full HTTP flow
(setup → login → create → start → logs → stop).

## Roadmap

- **Phase 2:** ~~Discord alerts, automatic backup, historical metrics~~ ✔
- **Phase 3:** ~~Oxide/uMod plugins~~ ✔, advanced multi-server, 2FA (TOTP), licensing

> Independent project, not affiliated with Facepunch Studios. Does not redistribute game binaries:
> it only automates SteamCMD.
