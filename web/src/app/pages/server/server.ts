import { Component, ElementRef, OnDestroy, OnInit, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { readError } from '../../core/auth.service';
import { EventsService } from '../../core/events.service';
import { Backup, BackupSchedule, DiscordEvents, ConfigField, LogEntry, Server, ServerConfig, ServerState, WipeSchedule } from '../../core/models';
import { I18nService } from '../../core/i18n.service';
import { TPipe } from '../../shared/t.pipe';

type Tab = 'console' | 'config' | 'backups' | 'settings';

@Component({
  selector: 'app-server',
  imports: [FormsModule, RouterLink, TPipe],
  templateUrl: './server.html',
  styleUrl: './server.css',
})
export class ServerPage implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly events = inject(EventsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly i18n = inject(I18nService);
  private sub: Subscription | null = null;

  readonly server = signal<Server | null>(null);
  readonly tab = signal<Tab>('console');
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly busy = signal(false);

  readonly logs = signal<LogEntry[]>([]);
  readonly filter = signal('');
  readonly autoscroll = signal(true);
  readonly command = signal('');

  readonly config = signal<ServerConfig | null>(null);
  readonly configDraft = signal<Record<string, string | number | boolean>>({});
  readonly configSaving = signal(false);

  readonly backups = signal<Backup[]>([]);
  readonly backupBusy = signal<string | null>(null);

  settings = {
    name: '',
    mode: 'local' as 'local' | 'remote',
    host: '127.0.0.1',
    hostname: '',
    port: 28015,
    rconPort: 28016,
    rconPassword: '',
    seed: 0,
    worldSize: 3000,
    maxPlayers: 50,
    saveInterval: 300,
    startedAt: '',
    autoUpdate: true,
    autoRestart: true,
    wipeSchedule: { enabled: false, dayOfMonth: 1, time: '04:00', type: 'map', rotateSeed: false } as WipeSchedule,
    backupSchedule: { enabled: false, time: '03:00', keep: 7 } as BackupSchedule,
    discordEnabled: false,
    discordWebhook: '',
    discordEvents: { online: true, offline: true, crash: true, wipe: true, backup: false } as DiscordEvents,
  };

  private id = '';

  private readonly logBox = viewChild<ElementRef<HTMLDivElement>>('logBox');

  constructor() {
    effect(() => {
      const entries = this.logs();
      const box = this.logBox()?.nativeElement;
      if (!box || !this.autoscroll() || !entries.length) return;
      queueMicrotask(() => {
        box.scrollTop = box.scrollHeight;
      });
    });
  }

  ngOnInit(): void {
    this.id = this.route.snapshot.paramMap.get('id') ?? '';
    this.events.connect();
    this.sub = this.events.events.subscribe((event) => {
      if (event.type === 'status' && event.serverId === this.id) {
        this.server.update((current) => (current ? { ...current, status: event.status } : current));
      }
      if (event.type === 'log' && event.serverId === this.id) {
        this.logs.update((list) => [...list.slice(-799), event.entry]);
      }
    });
    this.load();
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  isRemote(): boolean {
    return this.server()?.mode === 'remote';
  }

  load(): void {
    this.api.server(this.id).subscribe({
      next: (server) => {
        this.server.set(server);
        this.settings = {
          name: server.name,
          mode: server.mode,
          host: server.host,
          hostname: server.hostname,
          port: server.port,
          rconPort: server.rconPort,
          rconPassword: '',
          seed: server.seed,
          worldSize: server.worldSize,
          maxPlayers: server.maxPlayers,
          saveInterval: server.saveInterval,
          startedAt: toLocalInput(server.startedAtOverride),
          autoUpdate: server.autoUpdate,
          autoRestart: server.autoRestart,
          wipeSchedule: { ...server.wipeSchedule },
          backupSchedule: { ...server.backupSchedule },
          discordEnabled: server.discord.enabled,
          discordWebhook: '',
          discordEvents: { ...server.discord.events },
        };
        if (!this.isRemote()) {
          this.loadConfig();
          this.loadBackups();
        }
      },
      error: (err) => this.error.set(readError(err, 'Servidor não encontrado.')),
    });
    this.api.logs(this.id, 400).subscribe({ next: (logs) => this.logs.set(logs) });
  }

  setTab(tab: Tab): void {
    this.tab.set(tab);
    if (tab === 'config') this.loadConfig();
    if (tab === 'backups') this.loadBackups();
  }

  start(skipUpdate = false): void {
    this.action(this.api.start(this.id, skipUpdate));
  }

  stop(): void {
    this.action(this.api.stop(this.id));
  }

  restart(): void {
    this.action(this.api.restart(this.id));
  }

  testDiscord(): void {
    this.busy.set(true);
    this.api.testDiscord(this.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.notice.set('Mensagem de teste enviada ao Discord.');
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(readError(err, 'Falha ao enviar a mensagem de teste.'));
      },
    });
  }

  updateFiles(): void {
    this.busy.set(true);
    this.notice.set('Atualizando via SteamCMD...');
    this.api.update(this.id).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.notice.set(result.ok ? 'Atualização concluída.' : `Falha: ${result.error ?? result.code}`);
        this.load();
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(readError(err, 'Falha ao atualizar.'));
      },
    });
  }

  sendCommand(): void {
    const command = this.command().trim();
    if (!command) return;
    this.api.command(this.id, command).subscribe({
      next: () => this.command.set(''),
      error: (err) => this.error.set(readError(err, 'Comando falhou.')),
    });
  }

  loadConfig(): void {
    this.api.config(this.id).subscribe({
      next: (config) => {
        this.config.set(config);
        this.configDraft.set({ ...config.values });
      },
      error: (err) => this.error.set(readError(err, 'Falha ao ler server.cfg.')),
    });
  }

  saveConfig(): void {
    this.configSaving.set(true);
    this.api.saveConfig(this.id, this.configDraft()).subscribe({
      next: (config) => {
        this.config.set(config);
        this.configDraft.set({ ...config.values });
        this.configSaving.set(false);
        this.notice.set('server.cfg salvo. Reinicie o servidor para aplicar.');
      },
      error: (err) => {
        this.configSaving.set(false);
        this.error.set(readError(err, 'Falha ao salvar server.cfg.'));
      },
    });
  }

  setValue(field: ConfigField, value: string | number | boolean): void {
    this.configDraft.update((draft) => ({ ...draft, [field.key]: value }));
  }

  groups(): { name: string; fields: ConfigField[] }[] {
    const schema = this.config()?.schema ?? [];
    const map = new Map<string, ConfigField[]>();
    for (const field of schema) {
      const list = map.get(field.group) ?? [];
      list.push(field);
      map.set(field.group, list);
    }
    return [...map.entries()].map(([name, fields]) => ({ name, fields }));
  }

  loadBackups(): void {
    this.api.backups(this.id).subscribe({ next: (list) => this.backups.set(list) });
  }

  createBackup(): void {
    this.backupBusy.set('create');
    this.api.createBackup(this.id).subscribe({
      next: () => {
        this.backupBusy.set(null);
        this.notice.set('Backup criado.');
        this.loadBackups();
      },
      error: (err) => {
        this.backupBusy.set(null);
        this.error.set(readError(err, 'Falha ao criar backup.'));
      },
    });
  }

  restore(backup: Backup): void {
    if (!confirm(`Restaurar "${backup.name}"? O estado atual será salvo antes em um backup de segurança.`)) return;
    this.backupBusy.set(backup.name);
    this.api.restoreBackup(this.id, backup.name).subscribe({
      next: (result) => {
        this.backupBusy.set(null);
        this.notice.set(
          `Backup restaurado.${result.safetyBackup ? ` Segurança: ${result.safetyBackup}` : ''}`,
        );
        this.loadBackups();
      },
      error: (err) => {
        this.backupBusy.set(null);
        this.error.set(readError(err, 'Falha ao restaurar backup.'));
      },
    });
  }

  removeBackup(backup: Backup): void {
    if (!confirm(`Excluir "${backup.name}"?`)) return;
    this.backupBusy.set(backup.name);
    this.api.deleteBackup(this.id, backup.name).subscribe({
      next: () => {
        this.backupBusy.set(null);
        this.loadBackups();
      },
      error: (err) => {
        this.backupBusy.set(null);
        this.error.set(readError(err, 'Falha ao excluir backup.'));
      },
    });
  }

  saveSettings(): void {
    this.busy.set(true);
    const payload: Partial<Server> = {
      name: this.settings.name,
      mode: this.settings.mode,
      host: this.settings.host,
      hostname: this.settings.hostname,
      port: this.settings.port,
      rconPort: this.settings.rconPort,
      seed: this.settings.seed,
      worldSize: this.settings.worldSize,
      maxPlayers: this.settings.maxPlayers,
      saveInterval: this.settings.saveInterval,
      startedAtOverride: this.settings.startedAt ? new Date(this.settings.startedAt).getTime() : null,
      autoUpdate: this.settings.autoUpdate,
      autoRestart: this.settings.autoRestart,
      wipeSchedule: {
        ...this.settings.wipeSchedule,
        enabled: this.settings.mode === 'remote' ? false : this.settings.wipeSchedule.enabled,
      },
      backupSchedule: {
        ...this.settings.backupSchedule,
        enabled: this.settings.mode === 'remote' ? false : this.settings.backupSchedule.enabled,
      },
    };
    payload.discord = {
      enabled: this.settings.discordEnabled,
      events: { ...this.settings.discordEvents },
      ...(this.settings.discordWebhook.trim() ? { webhookUrl: this.settings.discordWebhook.trim() } : {}),
    } as Server['discord'];
    if (this.settings.rconPassword) payload.rconPassword = this.settings.rconPassword;
    this.api.updateServer(this.id, payload).subscribe({
      next: (server) => {
        this.server.set(server);
        this.busy.set(false);
        this.notice.set('Configurações salvas.');
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(readError(err, 'Falha ao salvar.'));
      },
    });
  }

  removeServer(): void {
    if (!confirm('Excluir este servidor do painel? Os arquivos e saves não serão apagados.')) return;
    this.api.deleteServer(this.id).subscribe({
      next: () => void this.router.navigate(['/']),
      error: (err) => this.error.set(readError(err, 'Falha ao excluir.')),
    });
  }

  visibleLogs(): LogEntry[] {
    const term = this.filter().trim().toLowerCase();
    if (!term) return this.logs();
    return this.logs().filter((entry) => entry.line.toLowerCase().includes(term));
  }

  pillClass(state: ServerState | undefined): string {
    return `pill ${state ?? 'stopped'}`;
  }

  stateLabel(state: ServerState | undefined): string {
    switch (state) {
      case 'running':
        return this.i18n.t('state.running');
      case 'starting':
        return this.i18n.t('state.starting');
      case 'stopping':
        return this.i18n.t('state.stopping');
      case 'updating':
        return this.i18n.t('state.updating');
      case 'error':
        return this.i18n.t('state.error');
      default:
        return this.i18n.t('state.stopped');
    }
  }

  uptime(ms: number | undefined): string {
    if (!ms || ms <= 0) return '—';
    const total = Math.floor(ms / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  setWipeType(type: WipeSchedule['type']): void {
    this.settings.wipeSchedule.type = type;
    if (type === 'blueprints') this.settings.wipeSchedule.rotateSeed = false;
  }

  size(bytes: number): string {
    if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  date(ts: number): string {
    return new Date(ts).toLocaleString(this.i18n.lang() === 'pt' ? 'pt-BR' : 'en-US');
  }

  private action(request: ReturnType<ApiService['start']>): void {    this.busy.set(true);
    this.error.set(null);
    request.subscribe({
      next: (status) => {
        this.server.update((current) => (current ? { ...current, status } : current));
        this.busy.set(false);
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(readError(err, 'Ação falhou.'));
      },
    });
  }
}

function toLocalInput(ts: number | null): string {
  if (!ts) return '';
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
