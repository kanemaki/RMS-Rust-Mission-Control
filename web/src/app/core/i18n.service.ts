import { Injectable, computed, signal } from '@angular/core';

export type Lang = 'pt' | 'en';

const STORAGE_KEY = 'rmc.lang';

const pt: Record<string, string> = {
  'app.loading': 'Carregando painel...',
  'app.tagline': 'painel local',
  'app.nav.servers': 'Servidores',
  'app.logout': 'Sair',
  'app.theme.dark': 'Tema escuro',
  'app.theme.light': 'Tema claro',
  'app.lang.label': 'Idioma',

  'state.running': 'Online',
  'state.starting': 'Iniciando',
  'state.stopping': 'Parando',
  'state.updating': 'Atualizando',
  'state.error': 'Erro',
  'state.stopped': 'Parado',

  'common.save': 'Salvar',
  'common.cancel': 'Cancelar',
  'common.close': 'Fechar',
  'common.delete': 'Excluir',
  'common.restore': 'Restaurar',
  'common.send': 'Enviar',
  'common.clear': 'Limpar',
  'common.scan': 'Escanear',
  'common.connected': 'Conectado',
  'common.offline': 'Offline',
  'common.enabled': 'Ativado',
  'common.disabled': 'Desativado',
  'common.notFound': 'não encontrado',
  'common.port': 'Porta',
  'common.uptime': 'Uptime',
  'common.connectedFor': 'Conectado há',
  'common.players': 'Jogadores',
  'common.online': 'Online',
  'common.loading': 'Carregando...',

  'auth.login.subtitle': 'Entre para administrar seus servidores.',
  'auth.login.password': 'Senha do painel',
  'auth.login.submit': 'Entrar',
  'auth.setup.title': 'Primeiro acesso',
  'auth.setup.subtitle':
    'Defina a senha do painel. Ela protege o controle do servidor, o console RCON e os backups.',
  'auth.setup.password': 'Nova senha',
  'auth.setup.passwordHint': 'Mínimo de 10 caracteres. Use uma senha única, diferente da senha do RCON.',
  'auth.setup.confirm': 'Confirmar senha',
  'auth.setup.submit': 'Criar painel',
  'auth.error.short': 'A senha precisa ter ao menos 10 caracteres.',
  'auth.error.mismatch': 'As senhas não conferem.',

  'dash.title': 'Servidores',
  'dash.subtitle': 'Crie uma instância nova ou adicione um servidor que já está instalado.',
  'dash.addExisting': 'Adicionar existente',
  'dash.newServer': '+ Novo servidor',
  'dash.loading': 'Carregando servidores...',
  'dash.empty': 'Nenhum servidor cadastrado. Crie o primeiro ou adicione um existente.',
  'dash.open': 'Abrir',
  'dash.connect': 'Conectar',
  'dash.disconnect': 'Desconectar',
  'dash.start': 'Iniciar',
  'dash.stop': 'Parar',
  'dash.restart': 'Reiniciar',
  'dash.notInstalled': 'Servidor não instalado. Rode a atualização na página do servidor.',

  'create.title': 'Novo servidor do zero',
  'create.subtitle': 'O painel instala via SteamCMD, inicia e gerencia o processo nesta máquina.',
  'create.name': 'Nome',
  'create.namePlaceholder': 'Meu servidor',
  'create.identity': 'Identidade',
  'create.identityHint': 'Pasta de saves em server/<identidade>. Letras, números, "_" e "-".',
  'create.installDir': 'Pasta de instalação',
  'create.installDirHint': 'Onde o SteamCMD vai instalar. A pasta é criada se não existir.',
  'create.gamePort': 'Porta do jogo',
  'create.rconPort': 'Porta RCON',
  'create.rconPassword': 'Senha RCON',
  'create.rconPasswordHint': 'Letras, números, "_" e "-". O painel usa esta senha para o console RCON.',
  'create.seed': 'Seed',
  'create.worldSize': 'Tamanho do mapa',
  'create.maxPlayers': 'Máximo de jogadores',
  'create.submit': 'Criar servidor',

  'import.title': 'Adicionar servidor existente',
  'import.subtitle': 'Registra no painel um servidor que já está instalado e configurado.',
  'import.local': 'Nesta máquina',
  'import.remote': 'Em outra máquina',
  'import.installDirHint': 'Onde ficam RustDedicated.exe e a pasta server/.',
  'import.noExe': 'RustDedicated.exe não encontrado nessa pasta.',
  'import.noIdentities': 'Nenhuma identidade em server/. O servidor já rodou ao menos uma vez?',
  'import.identities': 'Identidades encontradas',
  'import.hasSave': 'com save',
  'import.noSave': 'sem save',
  'import.hasConfig': 'server.cfg',
  'import.noConfig': 'sem cfg',
  'import.manage': 'Como o painel deve tratar este servidor?',
  'import.attach': 'Já está rodando (conectar via RCON)',
  'import.process': 'O painel inicia e para',
  'import.attachHint': 'Conecta no processo em execução sem reiniciá-lo. Sem start/stop de processo.',
  'import.processHint': 'O painel assume o processo: start, stop e reinício automático.',
  'import.host': 'Host remoto',
  'import.hostHint': 'IP ou domínio com a porta RCON acessível.',
  'import.name': 'Nome no painel',
  'import.rconPasswordPlaceholder': 'deixe vazio se o servidor não usa senha',
  'import.submit': 'Adicionar ao painel',

  'uptime.hint.process': 'Desde o início do processo RustDedicated.',
  'uptime.hint.manual': 'Calculado a partir do início informado nos Ajustes.',
  'uptime.hint.session':
    'O RCON não informa o uptime do servidor. Informe o início em Ajustes para ver o tempo real.',

  'server.loading': 'Carregando servidor...',
  'server.back': '← Todos os servidores',
  'server.port': 'porta',
  'server.updateFiles': 'Atualizar arquivos',
  'server.tab.console': 'Console',
  'server.tab.backups': 'Backups',
  'server.tab.settings': 'Ajustes',
  'server.filter': 'Filtrar linhas...',
  'server.autoscroll': 'Auto-scroll',
  'server.emptyConsole': 'Sem linhas para exibir.',
  'server.commandPlaceholder': 'ex.: say Reinício em 5 minutos',
  'server.rconOffline': 'RCON offline: o console de comandos fica disponível quando o servidor termina de iniciar.',
  'server.configMissing': 'O arquivo ainda não existe. Salvar criará o server.cfg na pasta da identidade.',
  'server.preserved': 'linha(s) preservada(s) do arquivo original',
  'server.backups.title': 'Backups da identidade',
  'server.backups.subtitle': 'Inclui saves, blueprints e configurações de',
  'server.backups.create': 'Criar backup',
  'server.backups.empty': 'Nenhum backup ainda.',
  'server.backups.stopFirst': 'Pare o servidor para restaurar um backup.',
  'server.settings.title': 'Ajustes do servidor',
  'server.settings.name': 'Nome no painel',
  'server.settings.mode': 'Tipo',
  'server.settings.modeLocal': 'Local (gerencia o processo)',
  'server.settings.modeRemote': 'Remoto (só RCON)',
  'server.settings.host': 'Host do RCON',
  'server.settings.hostHint': 'Em modo local o RCON usa 127.0.0.1.',
  'server.settings.hostname': 'Hostname no jogo',
  'server.settings.gamePort': 'Porta do jogo',
  'server.settings.rconPort': 'Porta RCON',
  'server.settings.newPassword': 'Nova senha RCON',
  'server.settings.newPasswordPlaceholder': 'deixe vazio para manter',
  'server.settings.seed': 'Seed',
  'server.settings.worldSize': 'Tamanho do mapa',
  'server.settings.maxPlayers': 'Máximo de jogadores',
  'server.settings.saveInterval': 'Intervalo de save (s)',
  'server.settings.startedAt': 'Início do servidor',
  'server.settings.startedAtHint':
    'O RCON não informa uptime. Preencha quando o servidor subiu para o card mostrar o tempo real.',
  'server.settings.autoUpdate': 'Atualizar via SteamCMD ao iniciar',
  'server.settings.autoRestart': 'Reiniciar automaticamente após queda',
  'server.settings.modeLabel': 'Modo:',
  'server.settings.remoteMode': 'remoto (somente RCON)',
  'server.settings.hostLabel': 'Host:',
  'server.settings.remoteNote': 'Arquivos, backups e atualização ficam na máquina de origem.',
  'server.settings.install': 'Instalação:',
  'server.settings.executable': 'Executável:',
  'server.settings.dangerTitle': 'Remover do painel',
  'server.settings.dangerNote': 'Remove apenas o cadastro. Saves e arquivos permanecem no disco.',
  'server.settings.dangerAction': 'Excluir servidor',
};

const en: Record<string, string> = {
  'app.loading': 'Loading panel...',
  'app.tagline': 'local panel',
  'app.nav.servers': 'Servers',
  'app.logout': 'Sign out',
  'app.theme.dark': 'Dark theme',
  'app.theme.light': 'Light theme',
  'app.lang.label': 'Language',

  'state.running': 'Online',
  'state.starting': 'Starting',
  'state.stopping': 'Stopping',
  'state.updating': 'Updating',
  'state.error': 'Error',
  'state.stopped': 'Stopped',

  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.delete': 'Delete',
  'common.restore': 'Restore',
  'common.send': 'Send',
  'common.clear': 'Clear',
  'common.scan': 'Scan',
  'common.connected': 'Connected',
  'common.offline': 'Offline',
  'common.enabled': 'Enabled',
  'common.disabled': 'Disabled',
  'common.notFound': 'not found',
  'common.port': 'Port',
  'common.uptime': 'Uptime',
  'common.connectedFor': 'Connected for',
  'common.players': 'Players',
  'common.online': 'Online',
  'common.loading': 'Loading...',

  'auth.login.subtitle': 'Sign in to manage your servers.',
  'auth.login.password': 'Panel password',
  'auth.login.submit': 'Sign in',
  'auth.setup.title': 'First access',
  'auth.setup.subtitle':
    'Set the panel password. It protects server control, the RCON console and backups.',
  'auth.setup.password': 'New password',
  'auth.setup.passwordHint': 'At least 10 characters. Use a unique password, different from the RCON one.',
  'auth.setup.confirm': 'Confirm password',
  'auth.setup.submit': 'Create panel',
  'auth.error.short': 'The password must be at least 10 characters long.',
  'auth.error.mismatch': 'The passwords do not match.',

  'dash.title': 'Servers',
  'dash.subtitle': 'Create a new instance or add a server that is already installed.',
  'dash.addExisting': 'Add existing',
  'dash.newServer': '+ New server',
  'dash.loading': 'Loading servers...',
  'dash.empty': 'No servers registered. Create the first one or add an existing one.',
  'dash.open': 'Open',
  'dash.connect': 'Connect',
  'dash.disconnect': 'Disconnect',
  'dash.start': 'Start',
  'dash.stop': 'Stop',
  'dash.restart': 'Restart',
  'dash.notInstalled': 'Server not installed. Run the update on the server page.',

  'create.title': 'New server from scratch',
  'create.subtitle': 'The panel installs via SteamCMD, starts and manages the process on this machine.',
  'create.name': 'Name',
  'create.namePlaceholder': 'My server',
  'create.identity': 'Identity',
  'create.identityHint': 'Save folder at server/<identity>. Letters, numbers, "_" and "-".',
  'create.installDir': 'Install folder',
  'create.installDirHint': 'Where SteamCMD will install. The folder is created if missing.',
  'create.gamePort': 'Game port',
  'create.rconPort': 'RCON port',
  'create.rconPassword': 'RCON password',
  'create.rconPasswordHint': 'Letters, numbers, "_" and "-". The panel uses it for the RCON console.',
  'create.seed': 'Seed',
  'create.worldSize': 'Map size',
  'create.maxPlayers': 'Max players',
  'create.submit': 'Create server',

  'import.title': 'Add existing server',
  'import.subtitle': 'Registers a server that is already installed and configured.',
  'import.local': 'On this machine',
  'import.remote': 'On another machine',
  'import.installDirHint': 'Where RustDedicated.exe and the server/ folder live.',
  'import.noExe': 'RustDedicated.exe not found in that folder.',
  'import.noIdentities': 'No identity under server/. Has the server run at least once?',
  'import.identities': 'Identities found',
  'import.hasSave': 'with save',
  'import.noSave': 'no save',
  'import.hasConfig': 'server.cfg',
  'import.noConfig': 'no cfg',
  'import.manage': 'How should the panel handle this server?',
  'import.attach': 'Already running (connect via RCON)',
  'import.process': 'The panel starts and stops it',
  'import.attachHint': 'Connects to the running process without restarting it. No process start/stop.',
  'import.processHint': 'The panel owns the process: start, stop and automatic restart.',
  'import.host': 'Remote host',
  'import.hostHint': 'IP or domain with the RCON port reachable.',
  'import.name': 'Panel name',
  'import.rconPasswordPlaceholder': 'leave empty if the server has no password',
  'import.submit': 'Add to panel',

  'uptime.hint.process': 'Since the RustDedicated process started.',
  'uptime.hint.manual': 'Calculated from the start time set in Settings.',
  'uptime.hint.session':
    'RCON does not report server uptime. Set the start time in Settings to see real uptime.',

  'server.loading': 'Loading server...',
  'server.back': '← All servers',
  'server.port': 'port',
  'server.updateFiles': 'Update files',
  'server.tab.console': 'Console',
  'server.tab.backups': 'Backups',
  'server.tab.settings': 'Settings',
  'server.filter': 'Filter lines...',
  'server.autoscroll': 'Auto-scroll',
  'server.emptyConsole': 'No lines to show.',
  'server.commandPlaceholder': 'e.g.: say Restart in 5 minutes',
  'server.rconOffline': 'RCON offline: the command console is available once the server finishes starting.',
  'server.configMissing': 'The file does not exist yet. Saving will create server.cfg in the identity folder.',
  'server.preserved': 'line(s) preserved from the original file',
  'server.backups.title': 'Identity backups',
  'server.backups.subtitle': 'Includes saves, blueprints and settings for',
  'server.backups.create': 'Create backup',
  'server.backups.empty': 'No backups yet.',
  'server.backups.stopFirst': 'Stop the server to restore a backup.',
  'server.settings.title': 'Server settings',
  'server.settings.name': 'Panel name',
  'server.settings.mode': 'Type',
  'server.settings.modeLocal': 'Local (manages the process)',
  'server.settings.modeRemote': 'Remote (RCON only)',
  'server.settings.host': 'RCON host',
  'server.settings.hostHint': 'In local mode RCON uses 127.0.0.1.',
  'server.settings.hostname': 'In-game hostname',
  'server.settings.gamePort': 'Game port',
  'server.settings.rconPort': 'RCON port',
  'server.settings.newPassword': 'New RCON password',
  'server.settings.newPasswordPlaceholder': 'leave empty to keep',
  'server.settings.seed': 'Seed',
  'server.settings.worldSize': 'Map size',
  'server.settings.maxPlayers': 'Max players',
  'server.settings.saveInterval': 'Save interval (s)',
  'server.settings.startedAt': 'Server start time',
  'server.settings.startedAtHint':
    'RCON does not report uptime. Set when the server started so the card shows real uptime.',
  'server.settings.autoUpdate': 'Update via SteamCMD on start',
  'server.settings.autoRestart': 'Restart automatically after a crash',
  'server.settings.modeLabel': 'Mode:',
  'server.settings.remoteMode': 'remote (RCON only)',
  'server.settings.hostLabel': 'Host:',
  'server.settings.remoteNote': 'Files, backups and updates stay on the origin machine.',
  'server.settings.install': 'Install:',
  'server.settings.executable': 'Executable:',
  'server.settings.dangerTitle': 'Remove from panel',
  'server.settings.dangerNote': 'Removes only the registration. Saves and files stay on disk.',
  'server.settings.dangerAction': 'Delete server',
};

const dictionaries: Record<Lang, Record<string, string>> = { pt, en };

function readStored(): Lang {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'pt' || value === 'en') return value;
  } catch {
    /* localStorage indisponível */
  }
  return 'pt';
}

@Injectable({ providedIn: 'root' })
export class I18nService {
  readonly lang = signal<Lang>(readStored());
  readonly available: Lang[] = ['pt', 'en'];

  /** Muda quando o idioma muda, para pipes e computed reagirem. */
  readonly revision = computed(() => this.lang());

  constructor() {
    this.#applyLang(this.lang());
  }

  set(lang: Lang): void {
    this.lang.set(lang);
    this.#applyLang(lang);
  }

  t(key: string, params?: Record<string, string | number>): string {
    const dict = dictionaries[this.lang()];
    let text = dict[key] ?? dictionaries.pt[key] ?? key;
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  }

  #applyLang(lang: Lang): void {
    document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* ignora quota/privacidade */
    }
  }
}
