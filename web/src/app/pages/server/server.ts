import { Component, ElementRef, OnDestroy, OnInit, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { readError } from '../../core/auth.service';
import { EventsService } from '../../core/events.service';
import { Backup, BackupSchedule, ChatFilter, ChatMessage, DiscordEvents, ConfigField, LogEntry, ModerationEntry, OxidePlugin, OxidePluginConfig, OxideStatus, Player, PlayerAction, PlayerDetail, PlayersResponse, SamplesResponse, Sample, Server, ServerConfig, ServerState, WipeSchedule, RestartSchedule, UpdateSchedule, Announcements } from '../../core/models';
import { I18nService } from '../../core/i18n.service';
import { TPipe } from '../../shared/t.pipe';

type Tab = 'console' | 'players' | 'chat' | 'config' | 'metrics' | 'plugins' | 'backups' | 'automation' | 'settings';
type MetricsRange = '24h' | '7d' | '30d';

interface ChartSeries {
  line: string;
  yMax: number;
  peak: number | null;
  avg: number | null;
  last: number | null;
  limitY: number | null;
}

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

  readonly oxide = signal<OxideStatus | null>(null);
  readonly plugins = signal<OxidePlugin[]>([]);
  readonly oxideBusy = signal<string | null>(null);
  readonly newPluginUrl = signal('');
  readonly pluginFilter = signal('');
  readonly editingPlugin = signal<string | null>(null);
  readonly pluginConfigDraft = signal<OxidePluginConfig | null>(null);
  readonly pluginConfigRaw = signal('');
  readonly pluginConfigSaving = signal(false);

  readonly metricsRange = signal<MetricsRange>('24h');
  readonly metrics = signal<SamplesResponse | null>(null);
  readonly metricsLoading = signal(false);
  readonly ranges: MetricsRange[] = ['24h', '7d', '30d'];

  readonly players = signal<PlayersResponse | null>(null);
  readonly playerSearch = signal('');
  readonly selectedPlayer = signal<PlayerDetail | null>(null);
  readonly playerBusy = signal<string | null>(null);
  readonly noteDraft = signal('');
  readonly actionDraft = signal<{ action: PlayerAction; reason: string; minutes: string; sync: boolean } | null>(null);

  readonly chat = signal<ChatMessage[]>([]);
  readonly chatFlaggedOnly = signal(false);
  readonly chatDraft = signal('');
  readonly chatBusy = signal(false);
  readonly chatFilterDraft = signal<ChatFilter>({ enabled: false, keywords: [], notifyDiscord: true });
  readonly chatFilterText = signal('');
  readonly chatFilterSaving = signal(false);

  readonly announceBusy = signal(false);
  readonly announcementDraft = signal('');

  private readonly chartW = 600;
  private readonly chartH = 140;
  private readonly chartPad = 2;

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
    autoUpdate: false,
    autoRestart: true,
    wipeSchedule: { enabled: false, dayOfMonth: 1, time: '04:00', type: 'map', rotateSeed: false } as WipeSchedule,
    backupSchedule: { enabled: false, time: '03:00', keep: 7 } as BackupSchedule,
    restartSchedule: { enabled: false, time: '06:00', onlyIfEmpty: false } as RestartSchedule,
    updateSchedule: { enabled: false, time: '05:00', restartAfter: true } as UpdateSchedule,
    announcements: { enabled: false, intervalMinutes: 30, messages: [] } as Announcements,
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
        if (event.status.state !== 'running' && this.tab() === 'players') this.loadPlayers();
      }
      if (event.type === 'log' && event.serverId === this.id) {
        this.logs.update((list) => [...list.slice(-799), event.entry]);
      }
      if (event.type === 'chat' && event.serverId === this.id) {
        this.chat.update((list) => [...list.slice(-499), event.entry]);
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
          restartSchedule: { ...server.restartSchedule },
          updateSchedule: { ...server.updateSchedule },
          announcements: { ...server.announcements, messages: [...server.announcements.messages] },
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
    this.loadChatFilter();
  }

  setTab(tab: Tab): void {
    this.tab.set(tab);
    if (tab === 'config') this.loadConfig();
    if (tab === 'metrics') this.loadMetrics();
    if (tab === 'plugins') this.loadOxide();
    if (tab === 'backups') this.loadBackups();
    if (tab === 'players') this.loadPlayers();
    if (tab === 'chat') this.loadChat();
  }

  loadOxide(): void {
    this.api.oxideStatus(this.id).subscribe({ next: (status) => this.oxide.set(status) });
    this.api.oxidePlugins(this.id).subscribe({ next: (list) => this.plugins.set(list) });
  }

  installOxide(): void {
    const first = !this.oxide()?.installed;
    const question = first
      ? this.i18n.t('oxide.confirmInstall')
      : this.i18n.t('oxide.confirmUpdate');
    if (!confirm(question)) return;
    this.oxideBusy.set('install');
    this.api.installOxide(this.id).subscribe({
      next: (result) => {
        this.oxideBusy.set(null);
        this.oxide.update((current) => (current ? { ...current, installed: result.installed } : current));
        this.notice.set(this.i18n.t('oxide.installedNotice').replace('{version}', result.version ?? ''));
        this.loadOxide();
      },
      error: (err) => {
        this.oxideBusy.set(null);
        this.error.set(readError(err, this.i18n.t('oxide.installFailed')));
      },
    });
  }

  installFromUmod(): void {
    let url = this.newPluginUrl().trim();
    if (!url) return;
    // Aceita só o nome do plugin ou a URL completa.
    if (!/^https:\/\//i.test(url)) url = `https://umod.org/plugins/${url.replace(/\.cs$/i, '')}.cs`;
    this.oxideBusy.set('install-plugin');
    this.api.installPlugin(this.id, url).subscribe({
      next: (result) => {
        this.oxideBusy.set(null);
        this.newPluginUrl.set('');
        this.notice.set(this.i18n.t('oxide.pluginInstalled').replace('{name}', result.name));
        this.loadOxide();
      },
      error: (err) => {
        this.oxideBusy.set(null);
        this.error.set(readError(err, this.i18n.t('oxide.pluginInstallFailed')));
      },
    });
  }

  onPluginFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const stem = file.name.replace(/\.cs$/i, '');
    file
      .text()
      .then((content) => {
        this.oxideBusy.set('upload-plugin');
        this.api.uploadPlugin(this.id, stem, content).subscribe({
          next: (result) => {
            this.oxideBusy.set(null);
            this.notice.set(this.i18n.t('oxide.pluginInstalled').replace('{name}', result.name));
            this.loadOxide();
          },
          error: (err) => {
            this.oxideBusy.set(null);
            this.error.set(readError(err, this.i18n.t('oxide.pluginInstallFailed')));
          },
        });
      })
      .catch(() => this.error.set(this.i18n.t('oxide.readFailed')));
  }

  pluginAction(plugin: OxidePlugin, action: 'load' | 'unload' | 'reload'): void {
    this.oxideBusy.set(`${action}:${plugin.name}`);
    this.api.pluginAction(this.id, plugin.name, action).subscribe({
      next: (result) => {
        this.oxideBusy.set(null);
        this.notice.set(`${plugin.name}: ${result.response || this.i18n.t('common.done')}`);
        this.loadOxide();
      },
      error: (err) => {
        this.oxideBusy.set(null);
        this.error.set(readError(err, this.i18n.t('oxide.actionFailed')));
      },
    });
  }

  removePlugin(plugin: OxidePlugin): void {
    if (!confirm(this.i18n.t('oxide.confirmDelete').replace('{name}', plugin.name))) return;
    this.oxideBusy.set(`delete:${plugin.name}`);
    this.api.deletePlugin(this.id, plugin.name).subscribe({
      next: () => {
        this.oxideBusy.set(null);
        this.loadOxide();
      },
      error: (err) => {
        this.oxideBusy.set(null);
        this.error.set(readError(err, this.i18n.t('oxide.deleteFailed')));
      },
    });
  }

  openPluginConfig(plugin: OxidePlugin): void {
    this.editingPlugin.set(plugin.name);
    this.pluginConfigSaving.set(true);
    this.api.pluginConfig(this.id, plugin.name).subscribe({
      next: (config) => {
        this.pluginConfigDraft.set(config);
        this.pluginConfigRaw.set(config.raw);
        this.pluginConfigSaving.set(false);
      },
      error: (err) => {
        this.editingPlugin.set(null);
        this.pluginConfigSaving.set(false);
        this.error.set(readError(err, this.i18n.t('oxide.configFailed')));
      },
    });
  }

  savePluginConfig(): void {
    const name = this.editingPlugin();
    if (!name) return;
    this.pluginConfigSaving.set(true);
    this.api.savePluginConfig(this.id, name, this.pluginConfigRaw()).subscribe({
      next: (config) => {
        this.pluginConfigDraft.set(config);
        this.pluginConfigRaw.set(config.raw);
        this.pluginConfigSaving.set(false);
        this.notice.set(this.i18n.t('oxide.configSaved'));
      },
      error: (err) => {
        this.pluginConfigSaving.set(false);
        this.error.set(readError(err, this.i18n.t('oxide.configSaveFailed')));
      },
    });
  }

  closePluginConfig(): void {
    this.editingPlugin.set(null);
    this.pluginConfigDraft.set(null);
    this.pluginConfigRaw.set('');
  }

  visiblePlugins(): OxidePlugin[] {
    const term = this.pluginFilter().trim().toLowerCase();
    if (!term) return this.plugins();
    return this.plugins().filter(
      (plugin) =>
        plugin.name.toLowerCase().includes(term) ||
        plugin.title.toLowerCase().includes(term) ||
        plugin.author.toLowerCase().includes(term),
    );
  }

  loadMetrics(): void {
    this.metricsLoading.set(true);
    this.api.samples(this.id, this.metricsRange()).subscribe({
      next: (data) => {
        this.metrics.set(data);
        this.metricsLoading.set(false);
      },
      error: (err) => {
        this.metricsLoading.set(false);
        this.error.set(readError(err, 'Falha ao carregar métricas.'));
      },
    });
  }

  setMetricsRange(range: MetricsRange): void {
    if (range === this.metricsRange()) return;
    this.metricsRange.set(range);
    this.metrics.set(null);
    this.loadMetrics();
  }

  loadPlayers(): void {
    this.api.players(this.id, this.playerSearch()).subscribe({
      next: (data) => this.players.set(data),
      error: (err) => this.error.set(readError(err, this.i18n.t('players.title'))),
    });
  }

  searchPlayers(): void {
    this.loadPlayers();
  }

  openPlayer(steamId: string): void {
    this.playerBusy.set(steamId);
    this.api.player(this.id, steamId).subscribe({
      next: (detail) => {
        this.playerBusy.set(null);
        this.selectedPlayer.set(detail);
        this.noteDraft.set(detail.note ?? '');
        this.actionDraft.set(null);
      },
      error: (err) => {
        this.playerBusy.set(null);
        this.error.set(readError(err, this.i18n.t('players.action.failed')));
      },
    });
  }

  closePlayer(): void {
    this.selectedPlayer.set(null);
    this.actionDraft.set(null);
  }

  startAction(action: PlayerAction): void {
    this.actionDraft.set({ action, reason: '', minutes: '', sync: action === 'ban' });
  }

  cancelAction(): void {
    this.actionDraft.set(null);
  }

  setActionReason(value: string): void {
    this.actionDraft.update((draft) => (draft ? { ...draft, reason: value } : draft));
  }

  setActionMinutes(value: string): void {
    this.actionDraft.update((draft) => (draft ? { ...draft, minutes: value } : draft));
  }

  setActionSync(value: boolean): void {
    this.actionDraft.update((draft) => (draft ? { ...draft, sync: value } : draft));
  }

  confirmAction(): void {
    const draft = this.actionDraft();
    const player = this.selectedPlayer();
    if (!draft || !player) return;
    const minutes = draft.minutes.trim() ? Number(draft.minutes) : null;
    if (minutes != null && (!Number.isFinite(minutes) || minutes <= 0)) {
      this.error.set(this.i18n.t('players.action.minutes'));
      return;
    }
    this.playerBusy.set(draft.action);
    this.api
      .moderate(this.id, player.steamId, {
        action: draft.action,
        reason: draft.reason.trim() || undefined,
        minutes: draft.action === 'ban' ? minutes : null,
        sync: draft.action === 'ban' ? draft.sync : false,
        name: player.name,
      })
      .subscribe({
        next: (result) => {
          this.playerBusy.set(null);
          this.actionDraft.set(null);
          let message = this.i18n.t('players.action.done', { action: this.actionLabel(draft.action) });
          if (result.sync && result.sync.total) {
            message += ` ${this.i18n.t('players.action.syncResult', {
              applied: result.sync.applied,
              total: result.sync.total,
            })}`;
          }
          this.notice.set(message);
          this.openPlayer(player.steamId);
          this.loadPlayers();
        },
        error: (err) => {
          this.playerBusy.set(null);
          this.error.set(readError(err, this.i18n.t('players.action.failed')));
        },
      });
  }

  saveNote(): void {
    const player = this.selectedPlayer();
    if (!player) return;
    this.playerBusy.set('note');
    this.api.setPlayerNote(this.id, player.steamId, this.noteDraft()).subscribe({
      next: (result) => {
        this.playerBusy.set(null);
        this.selectedPlayer.update((current) => (current ? { ...current, note: result.note } : current));
        this.notice.set(this.i18n.t('players.noteSaved'));
      },
      error: (err) => {
        this.playerBusy.set(null);
        this.error.set(readError(err, this.i18n.t('players.action.failed')));
      },
    });
  }

  loadChat(): void {
    this.api.chat(this.id, this.chatFlaggedOnly()).subscribe({
      next: (list) => this.chat.set(list),
      error: (err) => this.error.set(readError(err, this.i18n.t('chat.title'))),
    });
  }

  setChatFlagged(flagged: boolean): void {
    if (flagged === this.chatFlaggedOnly()) return;
    this.chatFlaggedOnly.set(flagged);
    this.loadChat();
  }

  sendSay(): void {
    const message = this.chatDraft().trim();
    if (!message) return;
    this.chatBusy.set(true);
    this.api.say(this.id, message).subscribe({
      next: () => {
        this.chatBusy.set(false);
        this.chatDraft.set('');
        this.notice.set(this.i18n.t('chat.saySent'));
      },
      error: (err) => {
        this.chatBusy.set(false);
        this.error.set(readError(err, this.i18n.t('chat.sayFailed')));
      },
    });
  }

  loadChatFilter(): void {
    this.api.chatFilter(this.id).subscribe({
      next: (filter) => {
        this.chatFilterDraft.set(filter);
        this.chatFilterText.set(filter.keywords.join(', '));
      },
    });
  }

  setChatFilterEnabled(value: boolean): void {
    this.chatFilterDraft.update((draft) => ({ ...draft, enabled: value }));
  }

  setChatFilterNotify(value: boolean): void {
    this.chatFilterDraft.update((draft) => ({ ...draft, notifyDiscord: value }));
  }

  saveChatFilter(): void {
    const draft = this.chatFilterDraft();
    const keywords = this.chatFilterText()
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    this.chatFilterSaving.set(true);
    this.api.saveChatFilter(this.id, { ...draft, keywords }).subscribe({
      next: (filter) => {
        this.chatFilterSaving.set(false);
        this.chatFilterDraft.set(filter);
        this.chatFilterText.set(filter.keywords.join(', '));
        this.notice.set(this.i18n.t('chat.filter.saved'));
      },
      error: (err) => {
        this.chatFilterSaving.set(false);
        this.error.set(readError(err, this.i18n.t('chat.filter.failed')));
      },
    });
  }

  actionLabel(action: PlayerAction): string {
    return this.i18n.t(`players.action.${action}`);
  }

  actorLabel(actor: string): string {
    const key = `players.actor.${actor}`;
    const label = this.i18n.t(key);
    return label === key ? actor : label;
  }

  playerBadge(player: Player): string {
    if (player.banned) {
      return player.banExpiresAt
        ? this.i18n.t('players.banUntil', { date: this.date(player.banExpiresAt) })
        : this.i18n.t('players.banned');
    }
    if (player.owner) return this.i18n.t('players.owner');
    if (player.muted) return this.i18n.t('players.muted');
    return '';
  }

  moderationNote(entry: ModerationEntry): string {
    const parts = [this.date(entry.ts), this.actorLabel(entry.actor)];
    if (entry.expiresAt) parts.push(this.i18n.t('players.banUntil', { date: this.date(entry.expiresAt) }));
    return parts.join(' · ');
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

  addAnnouncementMessage(): void {
    const text = this.announcementDraft().replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
    if (!text) return;
    if (this.settings.announcements.messages.length >= 20) {
      this.error.set('O limite é de 20 mensagens por servidor.');
      return;
    }
    this.settings.announcements.messages.push(text);
    this.announcementDraft.set('');
  }

  removeAnnouncementMessage(index: number): void {
    this.settings.announcements.messages.splice(index, 1);
  }

  sendAnnouncementNow(): void {
    this.announceBusy.set(true);
    const message = this.announcementDraft().trim();
    this.api.announce(this.id, message || undefined).subscribe({
      next: (result) => {
        this.announceBusy.set(false);
        this.notice.set(`Anúncio enviado: ${result.message}`);
      },
      error: (err) => {
        this.announceBusy.set(false);
        this.error.set(readError(err, 'Falha ao enviar anúncio.'));
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
      restartSchedule: {
        ...this.settings.restartSchedule,
        enabled: this.settings.mode === 'remote' ? false : this.settings.restartSchedule.enabled,
      },
      updateSchedule: {
        ...this.settings.updateSchedule,
        enabled: this.settings.mode === 'remote' ? false : this.settings.updateSchedule.enabled,
      },
      announcements: {
        ...this.settings.announcements,
        messages: [...this.settings.announcements.messages],
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

  readonly playersChart = computed<ChartSeries | null>(() => {
    const data = this.metrics();
    if (!data) return null;
    const points = data.samples.map((s) => ({ ts: s.ts, value: s.players ?? null }));
    const values = points.map((p) => p.value).filter((v): v is number => v != null);
    const peak = values.length ? Math.max(...values) : null;
    const weight = data.samples.reduce((acc, s) => acc + (s.samples ?? 1), 0);
    const avg = weight
      ? data.samples.reduce((acc, s) => acc + (s.players ?? 0) * (s.samples ?? 1), 0) / weight
      : null;
    const limit = this.server()?.status?.maxPlayers ?? 0;
    const yMax = Math.max(peak ?? 0, limit) * 1.1 || 1;
    return {
      line: this.chartLine(points, yMax, data),
      yMax,
      peak,
      avg,
      last: values.length ? values[values.length - 1] : null,
      limitY: limit > 0 ? this.scaleY(limit, yMax) : null,
    };
  });

  readonly cpuChart = computed<ChartSeries | null>(() => {
    const data = this.metrics();
    if (!data) return null;
    const points: { ts: number; value: number | null }[] = [];
    let prev: Sample | null = null;
    for (const s of data.samples) {
      let value: number | null = null;
      if (prev?.cpu != null && s.cpu != null) {
        const dtMs = s.ts - prev.ts;
        if (dtMs > 0 && dtMs <= data.bucketMs * 2) {
          value = Math.min(100, Math.max(0, ((s.cpu - prev.cpu) / (dtMs / 1000)) * 100));
        }
      }
      points.push({ ts: s.ts, value });
      prev = s.cpu != null ? s : null;
    }
    const values = points.map((p) => p.value).filter((v): v is number => v != null);
    return {
      line: this.chartLine(points, 100, data),
      yMax: 100,
      peak: values.length ? Math.max(...values) : null,
      avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
      last: values.length ? values[values.length - 1] : null,
      limitY: null,
    };
  });

  readonly memChart = computed<ChartSeries | null>(() => {
    const data = this.metrics();
    if (!data) return null;
    const points = data.samples.map((s) => ({ ts: s.ts, value: s.mem ?? null }));
    const values = points.map((p) => p.value).filter((v): v is number => v != null);
    const peak = values.length ? Math.max(...values) : null;
    return {
      line: this.chartLine(points, (peak ?? 0) * 1.1 || 1, data),
      yMax: (peak ?? 0) * 1.1 || 1,
      peak,
      avg: null,
      last: values.length ? values[values.length - 1] : null,
      limitY: null,
    };
  });

  metricsEmpty(): boolean {
    const data = this.metrics();
    return !data || data.samples.length === 0;
  }

  fmt(value: number | null | undefined, kind: 'players' | 'cpu' | 'mem'): string {
    if (value == null) return '—';
    if (kind === 'mem') return this.size(value);
    if (kind === 'cpu') return `${value.toFixed(0)}%`;
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  axisTime(ts: number | undefined): string {
    if (!ts) return '—';
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    if (this.metricsRange() === '24h') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}h`;
  }

  private chartLine(points: { ts: number; value: number | null }[], yMax: number, data: SamplesResponse): string {
    const scaleX = (ts: number) =>
      this.chartPad + ((ts - data.since) / Math.max(1, data.until - data.since)) * (this.chartW - 2 * this.chartPad);
    let line = '';
    let pen = false;
    for (const p of points) {
      if (p.value == null || !Number.isFinite(p.value)) {
        pen = false;
        continue;
      }
      line += `${pen ? 'L' : 'M'}${scaleX(p.ts).toFixed(1)},${this.scaleY(p.value, yMax).toFixed(1)} `;
      pen = true;
    }
    return line.trim();
  }

  private scaleY(value: number, yMax: number): number {
    const usable = this.chartH - 2 * this.chartPad;
    return this.chartH - this.chartPad - (Math.min(value, yMax) / yMax) * usable;
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
