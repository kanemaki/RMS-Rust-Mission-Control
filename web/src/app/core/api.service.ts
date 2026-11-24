import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  AuditEntry,
  Backup,
  BatchAction,
  BatchResponse,
  ChatFilter,
  ChatMessage,
  Group,
  InsightsResponse,
  InstallScan,
  LicenseStatus,
  LiveMapState,
  LivePluginStatus,
  LogEntry,
  MapMeta,
  ModerationEntry,
  ModerationResponse,
  OxidePlugin,
  OxidePluginConfig,
  OxideStatus,
  PlayerAction,
  PlayerDetail,
  PlayersResponse,
  SamplesResponse,
  Server,
  ServerConfig,
  ServerStatus,
  TotpSetup,
  TotpStatus,
  User,
  Me,
  Role,
} from './models';

export interface LoginResponse {
  ok: true;
  totpRequired?: boolean;
  challenge?: string;
  expiresAt?: number;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  setupStatus(): Observable<{ needsSetup: boolean }> {
    return this.http.get<{ needsSetup: boolean }>('/api/setup');
  }

  setup(password: string): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>('/api/setup', { password });
  }

  login(username: string, password: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>('/api/auth/login', { username, password });
  }

  logout(): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>('/api/auth/logout', {});
  }

  me(): Observable<Me> {
    return this.http.get<Me>('/api/auth/me');
  }

  users(): Observable<User[]> {
    return this.http.get<User[]>('/api/users');
  }

  createUser(payload: { username: string; password: string; role: Role }): Observable<User> {
    return this.http.post<User>('/api/users', payload);
  }

  updateUser(id: number, payload: { role?: Role; disabled?: boolean }): Observable<User> {
    return this.http.patch<User>(`/api/users/${id}`, payload);
  }

  setUserPassword(id: number, password: string): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`/api/users/${id}/password`, { password });
  }

  resetUserTotp(id: number): Observable<User> {
    return this.http.post<User>(`/api/users/${id}/totp/reset`, {});
  }

  deleteUser(id: number): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`/api/users/${id}`);
  }

  loginTotp(challenge: string, code: string): Observable<{ ok: true; recovery: boolean }> {
    return this.http.post<{ ok: true; recovery: boolean }>('/api/auth/login/totp', { challenge, code });
  }

  totpStatus(): Observable<TotpStatus> {
    return this.http.get<TotpStatus>('/api/auth/totp');
  }

  totpSetup(): Observable<TotpSetup> {
    return this.http.post<TotpSetup>('/api/auth/totp/setup', {});
  }

  totpEnable(code: string): Observable<{ ok: true; recoveryCodes: string[] }> {
    return this.http.post<{ ok: true; recoveryCodes: string[] }>('/api/auth/totp/enable', { code });
  }

  totpDisable(password: string, code: string): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>('/api/auth/totp/disable', { password, code });
  }

  licenseStatus(): Observable<LicenseStatus> {
    return this.http.get<LicenseStatus>('/api/license');
  }

  applyLicense(text: string): Observable<LicenseStatus> {
    return this.http.post<LicenseStatus>('/api/license', { text });
  }

  removeLicense(): Observable<{ ok: true; removed: boolean; license: LicenseStatus }> {
    return this.http.delete<{ ok: true; removed: boolean; license: LicenseStatus }>('/api/license');
  }

  servers(): Observable<Server[]> {
    return this.http.get<Server[]>('/api/servers');
  }

  groups(): Observable<Group[]> {
    return this.http.get<Group[]>('/api/groups');
  }

  createGroup(name: string): Observable<Group> {
    return this.http.post<Group>('/api/groups', { name });
  }

  renameGroup(id: string, name: string): Observable<Group> {
    return this.http.patch<Group>(`/api/groups/${id}`, { name });
  }

  deleteGroup(id: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`/api/groups/${id}`);
  }

  batch(ids: string[], action: BatchAction): Observable<BatchResponse> {
    return this.http.post<BatchResponse>('/api/servers/batch', { ids, action });
  }

  defaultInstallDir(): Observable<{ defaultInstallDir: string }> {
    return this.http.get<{ defaultInstallDir: string }>('/api/discover');
  }

  discover(installDir: string): Observable<InstallScan> {
    return this.http.post<InstallScan>('/api/discover', { installDir });
  }

  server(id: string): Observable<Server> {
    return this.http.get<Server>(`/api/servers/${id}`);
  }

  createServer(payload: Partial<Server>): Observable<Server> {
    return this.http.post<Server>('/api/servers', payload);
  }

  updateServer(id: string, payload: Partial<Server>): Observable<Server> {
    return this.http.patch<Server>(`/api/servers/${id}`, payload);
  }

  deleteServer(id: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`/api/servers/${id}`);
  }

  start(id: string, skipUpdate = false): Observable<ServerStatus> {
    return this.http.post<ServerStatus>(`/api/servers/${id}/start`, { skipUpdate });
  }

  stop(id: string): Observable<ServerStatus> {
    return this.http.post<ServerStatus>(`/api/servers/${id}/stop`, {});
  }

  restart(id: string, skipUpdate = false): Observable<ServerStatus> {
    return this.http.post<ServerStatus>(`/api/servers/${id}/restart`, { skipUpdate });
  }

  update(id: string): Observable<{ ok: boolean; code: number | null; error?: string; status: ServerStatus }> {
    return this.http.post<{ ok: boolean; code: number | null; error?: string; status: ServerStatus }>(
      `/api/servers/${id}/update`,
      {},
    );
  }

  command(id: string, command: string): Observable<{ response: string }> {
    return this.http.post<{ response: string }>(`/api/servers/${id}/command`, { command });
  }

  logs(id: string, limit = 300): Observable<LogEntry[]> {
    return this.http.get<LogEntry[]>(`/api/servers/${id}/logs?limit=${limit}`);
  }

  samples(id: string, range: '24h' | '7d' | '30d'): Observable<SamplesResponse> {
    return this.http.get<SamplesResponse>(`/api/servers/${id}/samples`, { params: { range } });
  }

  players(id: string, search = ''): Observable<PlayersResponse> {
    return this.http.get<PlayersResponse>(`/api/servers/${id}/players`, { params: { search } });
  }

  player(id: string, steamId: string): Observable<PlayerDetail> {
    return this.http.get<PlayerDetail>(`/api/servers/${id}/players/${steamId}`);
  }

  setPlayerNote(id: string, steamId: string, note: string): Observable<{ steamId: string; note: string }> {
    return this.http.patch<{ steamId: string; note: string }>(`/api/servers/${id}/players/${steamId}`, { note });
  }

  moderate(
    id: string,
    steamId: string,
    payload: { action: PlayerAction; reason?: string; minutes?: number | null; sync?: boolean; name?: string },
  ): Observable<ModerationResponse> {
    return this.http.post<ModerationResponse>(`/api/servers/${id}/players/${steamId}/action`, payload);
  }

  moderation(id: string, steamId?: string): Observable<ModerationEntry[]> {
    return this.http.get<ModerationEntry[]>(`/api/servers/${id}/moderation`, {
      params: steamId ? { steamId } : {},
    });
  }

  chat(id: string, flagged = false): Observable<ChatMessage[]> {
    return this.http.get<ChatMessage[]>(`/api/servers/${id}/chat`, { params: flagged ? { flagged: '1' } : {} });
  }

  say(id: string, message: string): Observable<{ response: string }> {
    return this.http.post<{ response: string }>(`/api/servers/${id}/chat`, { message });
  }

  announce(id: string, message?: string): Observable<{ message: string; response: string }> {
    return this.http.post<{ message: string; response: string }>(`/api/servers/${id}/announce`, {
      ...(message ? { message } : {}),
    });
  }

  insights(id: string, days: number, inactiveDays?: number): Observable<InsightsResponse> {
    return this.http.get<InsightsResponse>(`/api/servers/${id}/insights`, {
      params: { days: String(days), ...(inactiveDays ? { inactiveDays: String(inactiveDays) } : {}) },
    });
  }

  mapMeta(id: string): Observable<MapMeta> {
    return this.http.get<MapMeta>(`/api/servers/${id}/map`);
  }

  mapPngUrl(id: string): string {
    return `/api/servers/${id}/map.png`;
  }

  liveMap(id: string): Observable<LiveMapState> {
    return this.http.get<LiveMapState>(`/api/servers/${id}/live`);
  }

  livePlugin(id: string): Observable<LivePluginStatus> {
    return this.http.get<LivePluginStatus>(`/api/servers/${id}/live/plugin`);
  }

  installLivePlugin(id: string, intervalSeconds: number): Observable<LivePluginStatus> {
    return this.http.post<LivePluginStatus>(`/api/servers/${id}/live/plugin`, { intervalSeconds });
  }

  removeLivePlugin(id: string): Observable<LivePluginStatus> {
    return this.http.delete<LivePluginStatus>(`/api/servers/${id}/live/plugin`);
  }

  rotateLiveToken(id: string): Observable<{ token: string; plugin: LivePluginStatus }> {
    return this.http.post<{ token: string; plugin: LivePluginStatus }>(`/api/servers/${id}/live/token`, {});
  }

  exportUrl(id: string, kind: 'players' | 'sessions'): string {
    return `/api/servers/${id}/export/${kind}.csv`;
  }

  chatFilter(id: string): Observable<ChatFilter> {
    return this.http.get<ChatFilter>(`/api/servers/${id}/chat-filter`);
  }

  saveChatFilter(id: string, filter: ChatFilter): Observable<ChatFilter> {
    return this.http.put<ChatFilter>(`/api/servers/${id}/chat-filter`, filter);
  }

  config(id: string): Observable<ServerConfig> {
    return this.http.get<ServerConfig>(`/api/servers/${id}/config`);
  }

  saveConfig(id: string, values: Record<string, string | number | boolean>): Observable<ServerConfig> {
    return this.http.put<ServerConfig>(`/api/servers/${id}/config`, { values });
  }

  testDiscord(id: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`/api/servers/${id}/discord/test`, {});
  }

  backups(id: string): Observable<Backup[]> {
    return this.http.get<Backup[]>(`/api/servers/${id}/backups`);
  }

  createBackup(id: string, label = 'manual'): Observable<Backup> {
    return this.http.post<Backup>(`/api/servers/${id}/backups`, { label });
  }

  restoreBackup(id: string, name: string): Observable<{ restored: string; safetyBackup: string | null }> {
    return this.http.post<{ restored: string; safetyBackup: string | null }>(
      `/api/servers/${id}/backups/${encodeURIComponent(name)}/restore`,
      {},
    );
  }

  deleteBackup(id: string, name: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`/api/servers/${id}/backups/${encodeURIComponent(name)}`);
  }

  audit(limit = 100): Observable<AuditEntry[]> {
    return this.http.get<AuditEntry[]>(`/api/audit?limit=${limit}`);
  }

  oxideStatus(id: string): Observable<OxideStatus> {
    return this.http.get<OxideStatus>(`/api/servers/${id}/oxide`);
  }

  installOxide(id: string): Observable<{ installed: boolean; version: string }> {
    return this.http.post<{ installed: boolean; version: string }>(`/api/servers/${id}/oxide/install`, {});
  }

  oxidePlugins(id: string): Observable<OxidePlugin[]> {
    return this.http.get<OxidePlugin[]>(`/api/servers/${id}/oxide/plugins`);
  }

  installPlugin(id: string, url: string): Observable<{ name: string; title: string }> {
    return this.http.post<{ name: string; title: string }>(`/api/servers/${id}/oxide/plugins`, { url });
  }

  uploadPlugin(id: string, name: string, content: string): Observable<{ name: string; title: string }> {
    return this.http.post<{ name: string; title: string }>(`/api/servers/${id}/oxide/plugins`, { name, content });
  }

  deletePlugin(id: string, name: string): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`/api/servers/${id}/oxide/plugins/${encodeURIComponent(name)}`);
  }

  pluginConfig(id: string, name: string): Observable<OxidePluginConfig> {
    return this.http.get<OxidePluginConfig>(`/api/servers/${id}/oxide/plugins/${encodeURIComponent(name)}/config`);
  }

  savePluginConfig(id: string, name: string, raw: string): Observable<OxidePluginConfig> {
    return this.http.put<OxidePluginConfig>(`/api/servers/${id}/oxide/plugins/${encodeURIComponent(name)}/config`, {
      raw,
    });
  }

  pluginAction(id: string, name: string, action: 'load' | 'unload' | 'reload'): Observable<{ response: string }> {
    return this.http.post<{ response: string }>(
      `/api/servers/${id}/oxide/plugins/${encodeURIComponent(name)}/${action}`,
      {},
    );
  }
}
