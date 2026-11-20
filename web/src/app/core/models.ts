export type ServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'updating' | 'error';

export interface ServerStatus {
  id: string;
  mode: 'local' | 'remote';
  host: string;
  state: ServerState;
  pid: number | null;
  startedAt: number | null;
  stoppedAt: number | null;
  uptimeMs: number;
  uptimeSource: 'process' | 'manual' | 'session' | null;
  players: number | null;
  playerNames?: string[];
  maxPlayers: number;
  rconConnected: boolean;
  lastError: string | null;
  autoRestart: boolean;
  autoUpdate: boolean;
  install: { installed: boolean; executable: string; steamCmd: boolean } | null;
}

export interface Server {
  id: string;
  name: string;
  identity: string;
  mode: 'local' | 'remote';
  host: string;
  installDir: string;
  steamCmdDir: string;
  executable: string;
  executableArgs: string[];
  oxide: boolean;
  port: number;
  rconPort: number;
  rconPasswordSet: boolean;
  /** Aceito apenas em create/update; nunca retornado pela API. */
  rconPassword?: string;
  hostname: string;
  seed: number;
  worldSize: number;
  maxPlayers: number;
  saveInterval: number;
  startedAtOverride: number | null;
  autoUpdate: boolean;
  autoRestart: boolean;
  extraArgs: string[];
  status: ServerStatus | null;
}

export interface LogEntry {
  ts: number;
  stream: string;
  line: string;
}

export interface ConfigField {
  key: string;
  label: string;
  type: 'string' | 'int' | 'float' | 'bool';
  group: string;
  min?: number;
  max?: number;
  maxLength?: number;
  hint?: string;
  secret?: boolean;
}

export interface ServerConfig {
  path: string;
  exists: boolean;
  values: Record<string, string | number | boolean>;
  unknown: string[];
  schema: ConfigField[];
}

export interface Backup {
  name: string;
  size: number;
  createdAt: number;
}

export interface AuditEntry {
  id: number;
  ts: number;
  action: string;
  serverId: string | null;
  detail: string | null;
  ip: string | null;
}

export interface DiscoveredIdentity {
  identity: string;
  configPath: string;
  hasConfig: boolean;
  hasSave: boolean;
  values: Record<string, string | number | boolean>;
}

export interface InstallScan {
  installDir: string;
  executable: string | null;
  installed: boolean;
  identities: DiscoveredIdentity[];
}

export type StreamEvent =
  | { type: 'hello'; servers: ServerStatus[] }
  | { type: 'status'; serverId: string; status: ServerStatus }
  | { type: 'log'; serverId: string; entry: LogEntry };
