import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  AuditEntry,
  Backup,
  BatchAction,
  BatchResponse,
  Group,
  InstallScan,
  LogEntry,
  OxidePlugin,
  OxidePluginConfig,
  OxideStatus,
  SamplesResponse,
  Server,
  ServerConfig,
  ServerStatus,
  TotpSetup,
  TotpStatus,
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

  login(password: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>('/api/auth/login', { password });
  }

  logout(): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>('/api/auth/logout', {});
  }

  me(): Observable<{ authenticated: true; expiresAt: number; totpEnabled: boolean }> {
    return this.http.get<{ authenticated: true; expiresAt: number; totpEnabled: boolean }>('/api/auth/me');
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
