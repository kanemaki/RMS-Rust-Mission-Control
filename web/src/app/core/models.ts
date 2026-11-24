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
  nextWipeAt?: number | null;
  nextBackupAt?: number | null;
  nextRestartAt?: number | null;
  nextUpdateAt?: number | null;
  nextAnnouncementAt?: number | null;
  install: { installed: boolean; executable: string; steamCmd: boolean } | null;
}

export interface WipeSchedule {
  enabled: boolean;
  dayOfMonth: number;
  time: string;
  type: 'map' | 'blueprints' | 'full';
  rotateSeed: boolean;
}

export interface BackupSchedule {
  enabled: boolean;
  time: string;
  keep: number;
}

export interface RestartSchedule {
  enabled: boolean;
  time: string;
  onlyIfEmpty: boolean;
}

export interface UpdateSchedule {
  enabled: boolean;
  time: string;
  restartAfter: boolean;
}

export interface Announcements {
  enabled: boolean;
  intervalMinutes: number;
  messages: string[];
}

export interface DiscordEvents {
  online: boolean;
  offline: boolean;
  crash: boolean;
  wipe: boolean;
  backup: boolean;
  moderation: boolean;
}

export interface ChatFilter {
  enabled: boolean;
  keywords: string[];
  notifyDiscord: boolean;
}

export type PlayerAction = 'kick' | 'ban' | 'unban' | 'mute' | 'unmute' | 'owner' | 'unowner';

export interface Player {
  steamId: string;
  name: string;
  online: boolean;
  onlineSince: number | null;
  firstSeen: number;
  lastSeen: number;
  lastSessionAt: number | null;
  sessionCount: number;
  note: string;
  muted: boolean;
  banned: boolean;
  banExpiresAt: number | null;
  owner: boolean;
  ownerSince: number | null;
  lastAction: PlayerAction | null;
  lastActionAt: number | null;
}

export interface PlayerSession {
  id: number;
  joined_at: number;
  left_at: number | null;
  last_seen: number;
  name: string;
}

export interface ModerationEntry {
  id: number;
  ts: number;
  serverId: string;
  steamId: string;
  name: string;
  action: PlayerAction;
  reason: string;
  minutes: number | null;
  expiresAt: number | null;
  resolvedAt: number | null;
  actor: string;
  synced: { from: string } | null;
}

export interface PlayerDetail extends Player {
  sessions: PlayerSession[];
  moderation: ModerationEntry[];
  chatCount: number;
  stats: PlayerStats;
}

export interface PlayerStats {
  steamId: string;
  totalMs: number;
  todayMs: number;
  weekMs: number;
  monthMs: number;
  avgSessionMs: number;
  sessions: number;
  activeDays: number;
  firstSeen: number | null;
  lastSeen: number | null;
  sessionCount: number;
}

export interface HeatmapCell {
  weekday: number;
  hour: number;
  ms: number;
  sessions: number;
}

export interface InsightsRanking {
  steamId: string;
  name: string;
  ms: number;
  sessions: number;
}

export interface InsightsResponse {
  days: number;
  inactiveDays: number;
  since: number;
  until: number;
  totals: {
    players: number;
    online: number;
    sessions: number;
    totalMs: number;
    todayMs: number;
    avgSessionMs: number;
    activeToday: number;
    newPlayers: number;
    returningPlayers: number;
    inactivePlayers: number;
  };
  heatmap: {
    days: number;
    since: number;
    until: number;
    cells: HeatmapCell[];
    peakMs: number;
    totalMs: number;
  };
  topByTime: InsightsRanking[];
  topBySessions: InsightsRanking[];
  retention: {
    newPlayers: { steamId: string; name: string; firstSeen: number }[];
    inactive: { steamId: string; name: string; lastSeen: number; daysAgo: number }[];
  };
}

export interface PlayersResponse {
  online: Player[];
  recent: Player[];
  total: number;
}

export interface ChatMessage {
  id: number;
  ts: number;
  serverId: string;
  steamId: string | null;
  username: string | null;
  message: string;
  channel: number | null;
  flagged: boolean;
  rule: string | null;
}

export interface BanSyncResult {
  group: string | null;
  total: number;
  applied: number;
  results: { id: string; name: string; ok: boolean; skipped?: boolean; error?: string }[];
}

export interface ModerationResponse {
  response: string;
  moderation: ModerationEntry;
  sync: BanSyncResult | null;
}

export interface DiscordSettings {
  enabled: boolean;
  webhookSet: boolean;
  events: DiscordEvents;
  /** Aceito apenas em update; nunca retornado pela API. */
  webhookUrl?: string;
  clearWebhook?: boolean;
}

export interface Server {
  id: string;
  name: string;
  identity: string;
  mode: 'local' | 'remote';
  host: string;
  group: string | null;
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
  wipeSchedule: WipeSchedule;
  backupSchedule: BackupSchedule;
  restartSchedule: RestartSchedule;
  updateSchedule: UpdateSchedule;
  announcements: Announcements;
  discord: DiscordSettings;
  chatFilter: ChatFilter;
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

export interface Sample {
  ts: number;
  state: ServerState;
  players: number;
  cpu: number | null;
  mem: number | null;
  samples?: number;
}

export interface SamplesResponse {
  range: '24h' | '7d' | '30d';
  bucketMs: number;
  since: number;
  until: number;
  samples: Sample[];
}

export interface AuditEntry {
  id: number;
  ts: number;
  action: string;
  serverId: string | null;
  detail: string | null;
  ip: string | null;
}

export interface OxideStatus {
  installed: boolean;
  pluginCount: number;
  pluginsDir: string;
}

export interface OxidePlugin {
  name: string;
  title: string;
  author: string;
  version: string;
  description: string;
  sizeBytes: number;
  updatedAt: number;
  hasConfig: boolean;
  loaded: boolean;
}

export interface OxidePluginConfig {
  path: string;
  exists: boolean;
  raw: string;
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

export interface Group {
  id: string;
  name: string;
  count: number;
}

export type BatchAction = 'start' | 'stop' | 'restart' | 'backup';

export interface BatchResultItem {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
  status?: ServerStatus | null;
  backup?: Backup;
}

export interface BatchResponse {
  ok: true;
  action: BatchAction;
  total: number;
  succeeded: number;
  failed: number;
  results: BatchResultItem[];
}

export type StreamEvent =
  | { type: 'hello'; servers: ServerStatus[] }
  | { type: 'status'; serverId: string; status: ServerStatus }
  | { type: 'log'; serverId: string; entry: LogEntry }
  | { type: 'chat'; serverId: string; entry: ChatMessage }
  | { type: 'positions'; serverId: string; state: LiveMapState };

export interface MapMeta {
  available: boolean;
  reason?: 'remote' | 'missing';
  file?: string;
  bytes?: number;
  mtime?: number;
  seed: number | null;
  worldSize: number | null;
  resolution?: number;
  size?: number;
  layers?: string[];
  bounds?: { min: number; max: number };
}

export interface LivePlayer {
  steamId: string;
  name: string;
  x: number;
  y: number;
  z: number;
  rot: number;
  hp: number | null;
  mx: number;
  my: number;
}

export interface LivePluginStatus {
  installed: boolean;
  enabled: boolean;
  oxide: boolean;
  token: string | null;
  intervalSeconds: number;
  path: string;
  agentUrl?: string;
}

export interface LiveMapState {
  serverId: string;
  worldSize: number;
  at: number | null;
  ageMs: number | null;
  stale: boolean;
  players: LivePlayer[];
  plugin?: LivePluginStatus;
}

export interface TotpStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
}

export type Role = 'owner' | 'admin' | 'viewer';

export interface User {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
  totpEnabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface Me {
  authenticated: true;
  id: number;
  username: string;
  role: Role;
  expiresAt: number;
  totpEnabled: boolean;
}

export interface TotpSetup {
  secret: string;
  otpauth: string;
  qr: string;
}

export type LicenseState = 'valid' | 'trial' | 'expired' | 'invalid' | 'none';

export interface LicenseTrial {
  days: number;
  startedAt: number | null;
  endsAt: number | null;
  daysLeft: number;
  active: boolean;
}

export interface LicenseStatus {
  checkedAt: number;
  licensed: boolean;
  readOnly: boolean;
  state: LicenseState;
  licensee: string | null;
  licenseId: string | null;
  plan: string | null;
  maxServers: number | null;
  issuedAt: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
  error: string | null;
  trial: LicenseTrial;
}
