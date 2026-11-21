import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription, forkJoin } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { readError } from '../../core/auth.service';
import { EventsService } from '../../core/events.service';
import {
  BatchAction,
  BatchResponse,
  DiscoveredIdentity,
  Group,
  InstallScan,
  Server,
  ServerState,
  TotpSetup,
  TotpStatus,
} from '../../core/models';
import { I18nService } from '../../core/i18n.service';
import { TPipe } from '../../shared/t.pipe';

type Panel = 'none' | 'create' | 'import' | 'groups' | 'security';
type ImportKind = 'local' | 'remote';
type Manage = 'attach' | 'process';

/** Seção de servidores exibida no dashboard: um grupo ou o bloco "Sem grupo". */
export interface ServerSection {
  groupId: string | null;
  name: string;
  servers: Server[];
}

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

  readonly groups = signal<Group[]>([]);
  readonly groupFilter = signal('all');
  readonly selectedIds = signal<Set<string>>(new Set());
  readonly batchBusy = signal(false);
  readonly batchResult = signal<BatchResponse | null>(null);
  readonly groupBusy = signal(false);
  readonly groupDraft = { name: '' };
  readonly renameDraft = { id: null as string | null, name: '' };

  readonly totp = signal<TotpStatus | null>(null);
  readonly totpSetupData = signal<TotpSetup | null>(null);
  readonly totpCodes = signal<string[]>([]);
  readonly totpBusy = signal(false);
  readonly totpError = signal<string | null>(null);
  readonly totpDisableOpen = signal(false);
  readonly totpDraft = { code: '', password: '' };

  readonly selectedCount = computed(() => this.selectedIds().size);

  readonly ungroupedCount = computed(() => {
    const known = new Set(this.groups().map((group) => group.id));
    return this.servers().filter((server) => !server.group || !known.has(server.group)).length;
  });

  /** Lista de seções renderizadas, já filtrada pelo chip ativo. */
  readonly sections = computed<ServerSection[]>(() => {
    const servers = this.servers();
    const known = new Set(this.groups().map((group) => group.id));
    const inGroup = (groupId: string | null) => (server: Server) =>
      groupId === null
        ? !server.group || !known.has(server.group)
        : server.group === groupId;

    const filter = this.groupFilter();
    if (filter === 'ungrouped') {
      return [{ groupId: null, name: '', servers: servers.filter(inGroup(null)) }];
    }
    if (filter !== 'all') {
      const group = this.groups().find((item) => item.id === filter);
      return [{ groupId: filter, name: group?.name ?? '', servers: servers.filter(inGroup(filter)) }];
    }
    const sections: ServerSection[] = this.groups()
      .map((group) => ({ groupId: group.id, name: group.name, servers: servers.filter(inGroup(group.id)) }))
      .filter((section) => section.servers.length > 0);
    const ungrouped = servers.filter(inGroup(null));
    if (ungrouped.length) sections.push({ groupId: null, name: '', servers: ungrouped });
    return sections;
  });

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
    group: '',
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
    forkJoin({ servers: this.api.servers(), groups: this.api.groups() }).subscribe({
      next: ({ servers, groups }) => {
        this.servers.set(servers);
        this.groups.set(groups);
        this.pruneSelection(servers);
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
    const next = this.panel() === panel ? 'none' : panel;
    this.panel.set(next);
    if (next === 'security') this.loadTotp();
  }

  // ---- Verificação em duas etapas (TOTP) ----

  loadTotp(): void {
    this.totpError.set(null);
    this.api.totpStatus().subscribe({
      next: (status) => this.totp.set(status),
      error: (err) => this.totpError.set(readError(err, 'Falha ao carregar o 2FA.')),
    });
  }

  startTotpSetup(): void {
    this.totpBusy.set(true);
    this.totpError.set(null);
    this.totpCodes.set([]);
    this.api.totpSetup().subscribe({
      next: (data) => {
        this.totpSetupData.set(data);
        this.totpDraft.code = '';
        this.totpBusy.set(false);
      },
      error: (err) => {
        this.totpError.set(readError(err, 'Falha ao iniciar a configuração do 2FA.'));
        this.totpBusy.set(false);
      },
    });
  }

  enableTotp(): void {
    const code = this.totpDraft.code.trim();
    if (!code || this.totpBusy()) return;
    this.totpBusy.set(true);
    this.totpError.set(null);
    this.api.totpEnable(code).subscribe({
      next: ({ recoveryCodes }) => {
        this.totpCodes.set(recoveryCodes);
        this.totpSetupData.set(null);
        this.totpDraft.code = '';
        this.totpBusy.set(false);
        this.loadTotp();
      },
      error: (err) => {
        this.totpError.set(readError(err, 'Código inválido.'));
        this.totpBusy.set(false);
      },
    });
  }

  disableTotp(): void {
    const { password, code } = this.totpDraft;
    if (!password || !code || this.totpBusy()) return;
    this.totpBusy.set(true);
    this.totpError.set(null);
    this.api.totpDisable(password, code.trim()).subscribe({
      next: () => {
        this.totpDraft.password = '';
        this.totpDraft.code = '';
        this.totpDisableOpen.set(false);
        this.totpCodes.set([]);
        this.totpBusy.set(false);
        this.loadTotp();
      },
      error: (err) => {
        this.totpError.set(readError(err, 'Não foi possível desativar o 2FA.'));
        this.totpBusy.set(false);
      },
    });
  }

  cancelTotpSetup(): void {
    this.totpSetupData.set(null);
    this.totpDraft.code = '';
    this.totpError.set(null);
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

  // ---- Seleção múltipla e ações em lote ----

  isSelected(id: string): boolean {
    return this.selectedIds().has(id);
  }

  toggleSelect(id: string): void {
    this.selectedIds.update((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  sectionAllSelected(section: ServerSection): boolean {
    return section.servers.length > 0 && section.servers.every((server) => this.selectedIds().has(server.id));
  }

  toggleSection(section: ServerSection): void {
    this.selectedIds.update((current) => {
      const next = new Set(current);
      const all = section.servers.every((server) => next.has(server.id));
      for (const server of section.servers) {
        if (all) next.delete(server.id);
        else next.add(server.id);
      }
      return next;
    });
  }

  clearSelection(): void {
    this.selectedIds.set(new Set());
    this.batchResult.set(null);
  }

  private pruneSelection(servers: Server[]): void {
    const ids = new Set(servers.map((server) => server.id));
    this.selectedIds.update((current) => new Set([...current].filter((id) => ids.has(id))));
  }

  runBatch(action: BatchAction): void {
    const ids = [...this.selectedIds()];
    if (this.batchBusy() || !ids.length) return;
    this.batchBusy.set(true);
    this.error.set(null);
    this.batchResult.set(null);
    this.api.batch(ids, action).subscribe({
      next: (response) => {
        this.batchBusy.set(false);
        this.batchResult.set(response);
        this.servers.update((list) =>
          list.map((server) => {
            const result = response.results.find((item) => item.id === server.id);
            return result?.status ? { ...server, status: result.status } : server;
          }),
        );
      },
      error: (err) => {
        this.batchBusy.set(false);
        this.error.set(readError(err, 'A ação em lote falhou.'));
      },
    });
  }

  batchSummary(): string {
    const result = this.batchResult();
    if (!result) return '';
    return this.i18n.t('batch.result', { succeeded: result.succeeded, total: result.total });
  }

  batchFailures() {
    return (this.batchResult()?.results ?? []).filter((item) => !item.ok);
  }

  // ---- Grupos ----

  groupCount(id: string): number {
    return this.servers().filter((server) => server.group === id).length;
  }

  sectionLabel(section: ServerSection): string {
    return section.groupId === null ? this.i18n.t('group.ungrouped') : section.name;
  }

  createGroup(): void {
    const name = this.groupDraft.name.trim();
    if (!name || this.groupBusy()) return;
    this.groupBusy.set(true);
    this.error.set(null);
    this.api.createGroup(name).subscribe({
      next: (group) => {
        this.groups.update((groups) => [...groups, group]);
        this.groupDraft.name = '';
        this.groupBusy.set(false);
      },
      error: (err) => {
        this.error.set(readError(err, 'Falha ao criar grupo.'));
        this.groupBusy.set(false);
      },
    });
  }

  startRename(group: Group): void {
    this.renameDraft.id = group.id;
    this.renameDraft.name = group.name;
  }

  cancelRename(): void {
    this.renameDraft.id = null;
    this.renameDraft.name = '';
  }

  renameGroup(): void {
    const id = this.renameDraft.id;
    if (!id) return;
    const name = this.renameDraft.name.trim();
    if (!name || this.groupBusy()) return;
    this.groupBusy.set(true);
    this.api.renameGroup(id, name).subscribe({
      next: (group) => {
        this.groups.update((groups) => groups.map((item) => (item.id === group.id ? group : item)));
        this.cancelRename();
        this.groupBusy.set(false);
      },
      error: (err) => {
        this.error.set(readError(err, 'Falha ao renomear grupo.'));
        this.groupBusy.set(false);
      },
    });
  }

  deleteGroup(group: Group): void {
    if (!confirm(this.i18n.t('group.deleteConfirm', { name: group.name }))) return;
    this.api.deleteGroup(group.id).subscribe({
      next: () => {
        this.groups.update((groups) => groups.filter((item) => item.id !== group.id));
        if (this.groupFilter() === group.id) this.groupFilter.set('all');
      },
      error: (err) => this.error.set(readError(err, 'Falha ao excluir grupo.')),
    });
  }

  assignGroup(server: Server, event: Event): void {
    const group = (event.target as HTMLSelectElement).value || null;
    if ((server.group ?? null) === group) return;
    this.busyId.set(server.id);
    this.error.set(null);
    this.api.updateServer(server.id, { group }).subscribe({
      next: (updated) => {
        this.servers.update((list) =>
          list.map((item) => (item.id === server.id ? { ...item, group: updated.group } : item)),
        );
        this.refreshGroupCounts();
        this.busyId.set(null);
      },
      error: (err) => {
        this.error.set(readError(err, 'Falha ao alterar o grupo.'));
        this.busyId.set(null);
      },
    });
  }

  private refreshGroupCounts(): void {
    const servers = this.servers();
    this.groups.update((groups) =>
      groups.map((group) => ({
        ...group,
        count: servers.filter((server) => server.group === group.id).length,
      })),
    );
  }

  create(): void {
    if (this.creating()) return;
    this.creating.set(true);
    this.error.set(null);
    this.api
      .createServer({ ...this.createDraft, mode: 'local', group: this.createDraft.group || null })
      .subscribe({
        next: (server) => {
          this.servers.update((list) => [...list, server]);
          this.refreshGroupCounts();
          this.panel.set('none');
          this.creating.set(false);
          this.createDraft.name = '';
          this.createDraft.identity = '';
          this.createDraft.rconPassword = '';
          this.createDraft.group = '';
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
        this.refreshGroupCounts();
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
