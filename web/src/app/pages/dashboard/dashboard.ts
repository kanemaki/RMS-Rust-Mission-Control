import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { readError } from '../../core/auth.service';
import { EventsService } from '../../core/events.service';
import { DiscoveredIdentity, InstallScan, Server, ServerState } from '../../core/models';
import { I18nService } from '../../core/i18n.service';
import { TPipe } from '../../shared/t.pipe';

type Panel = 'none' | 'create' | 'import';
type ImportKind = 'local' | 'remote';
type Manage = 'attach' | 'process';

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink, FormsModule, TPipe],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
})
export class DashboardPage implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly events = inject(EventsService);
  private readonly i18n = inject(I18nService);
  private sub: Subscription | null = null;

  readonly servers = signal<Server[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly busyId = signal<string | null>(null);
  readonly panel = signal<Panel>('none');
  readonly creating = signal(false);

  readonly createDraft = {
    name: '',
    identity: '',
    installDir: '',
    port: 28015,
    rconPort: 28016,
    rconPassword: '',
    seed: 4365201,
    worldSize: 3000,
    maxPlayers: 50,
  };

  readonly importKind = signal<ImportKind>('local');
  readonly manage = signal<Manage>('attach');
  readonly scanning = signal(false);
  readonly scan = signal<InstallScan | null>(null);
  readonly selected = signal<DiscoveredIdentity | null>(null);
  readonly importDraft = {
    installDir: '',
    name: '',
    identity: '',
    port: 28015,
    rconPort: 28016,
    rconPassword: '',
    host: '',
  };

  ngOnInit(): void {
    this.load();
    this.events.connect();
    this.sub = this.events.events.subscribe((event) => {
      if (event.type !== 'status') return;
      this.servers.update((list) =>
        list.map((server) => (server.id === event.serverId ? { ...server, status: event.status } : server)),
      );
    });
    this.api.defaultInstallDir().subscribe({
      next: ({ defaultInstallDir }) => {
        if (!this.importDraft.installDir) this.importDraft.installDir = defaultInstallDir;
        if (!this.createDraft.installDir) this.createDraft.installDir = defaultInstallDir;
      },
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  load(): void {
    this.loading.set(true);
    this.api.servers().subscribe({
      next: (servers) => {
        this.servers.set(servers);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(readError(err, 'Falha ao carregar servidores.'));
        this.loading.set(false);
      },
    });
  }

  openPanel(panel: Panel): void {
    this.error.set(null);
    this.panel.set(this.panel() === panel ? 'none' : panel);
  }

  start(server: Server): void {
    this.run(server, this.api.start(server.id));
  }

  stop(server: Server): void {
    this.run(server, this.api.stop(server.id));
  }

  restart(server: Server): void {
    this.run(server, this.api.restart(server.id));
  }

  create(): void {
    if (this.creating()) return;
    this.creating.set(true);
    this.error.set(null);
    this.api.createServer({ ...this.createDraft, mode: 'local' }).subscribe({
      next: (server) => {
        this.servers.update((list) => [...list, server]);
        this.panel.set('none');
        this.creating.set(false);
        this.createDraft.name = '';
        this.createDraft.identity = '';
        this.createDraft.rconPassword = '';
      },
      error: (err) => {
        this.error.set(readError(err, 'Falha ao criar servidor.'));
        this.creating.set(false);
      },
    });
  }

  scanInstall(): void {
    if (this.scanning()) return;
    this.scanning.set(true);
    this.error.set(null);
    this.scan.set(null);
    this.selected.set(null);
    this.api.discover(this.importDraft.installDir).subscribe({
      next: (scan) => {
        this.scan.set(scan);
        this.scanning.set(false);
        if (scan.identities.length) this.selectIdentity(scan.identities[0]);
      },
      error: (err) => {
        this.error.set(readError(err, 'Falha ao inspecionar a pasta.'));
        this.scanning.set(false);
      },
    });
  }

  selectIdentity(identity: DiscoveredIdentity): void {
    this.selected.set(identity);
    const values = identity.values;
    this.importDraft.identity = identity.identity;
    this.importDraft.name = String(values['server.hostname'] ?? identity.identity);
    this.importDraft.port = Number(values['server.port'] ?? 28015);
    this.importDraft.rconPort = Number(values['rcon.port'] ?? 28016);
    this.importDraft.rconPassword = String(values['rcon.password'] ?? '');
  }

  importServer(): void {
    if (this.creating()) return;
    this.creating.set(true);
    this.error.set(null);

    const attach = this.importKind() === 'local' && this.manage() === 'attach';
    const remote = this.importKind() === 'remote' || attach;
    const payload: Partial<Server> = {
      name: this.importDraft.name,
      identity: this.importDraft.identity,
      port: this.importDraft.port,
      rconPort: this.importDraft.rconPort,
      rconPassword: this.importDraft.rconPassword,
      mode: remote ? 'remote' : 'local',
      host: attach ? '127.0.0.1' : this.importDraft.host || '127.0.0.1',
      autoUpdate: false,
      autoRestart: !remote,
    };
    if (!remote) payload.installDir = this.importDraft.installDir;

    this.api.createServer(payload).subscribe({
      next: (server) => {
        this.servers.update((list) => [...list, server]);
        this.panel.set('none');
        this.creating.set(false);
        this.scan.set(null);
        this.selected.set(null);
      },
      error: (err) => {
        this.error.set(readError(err, 'Falha ao adicionar servidor.'));
        this.creating.set(false);
      },
    });
  }

  canCreate(): boolean {
    return Boolean(this.createDraft.name && this.createDraft.identity && this.createDraft.installDir);
  }

  /** Mostra no máximo 3 nomes para o card não crescer com 50 jogadores online. */
  playersSummary(server: Server): string {
    const names = server.status?.playerNames ?? [];
    if (!names.length) return '';
    const shown = names.slice(0, 3).join(', ');
    const rest = names.length - 3;
    if (rest <= 0) return shown;
    return `${shown} +${rest} ${rest === 1 ? 'outro' : 'outros'}`;
  }

  playersTooltip(server: Server): string {
    return (server.status?.playerNames ?? []).join(', ');
  }

  canImport(): boolean {
    if (!this.importDraft.name || !this.importDraft.identity) return false;
    if (this.importKind() === 'remote') return Boolean(this.importDraft.host);
    return Boolean(this.selected());
  }

  private run(server: Server, request: ReturnType<ApiService['start']>): void {
    this.busyId.set(server.id);
    this.error.set(null);
    request.subscribe({
      next: (status) => {
        this.servers.update((list) =>
          list.map((item) => (item.id === server.id ? { ...item, status } : item)),
        );
        this.busyId.set(null);
      },
      error: (err) => {
        this.error.set(readError(err, 'Ação falhou.'));
        this.busyId.set(null);
      },
    });
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

  /** O RCON do Rust não expõe uptime; sem fonte real o rótulo não pode dizer "Uptime". */
  uptimeLabel(server: Server): string {
    return server.status?.uptimeSource === 'session'
      ? this.i18n.t('common.connectedFor')
      : this.i18n.t('common.uptime');
  }

  uptimeHint(server: Server): string {
    switch (server.status?.uptimeSource) {
      case 'process':
        return this.i18n.t('uptime.hint.process');
      case 'manual':
        return this.i18n.t('uptime.hint.manual');
      case 'session':
        return this.i18n.t('uptime.hint.session');
      default:
        return '';
    }
  }
}
