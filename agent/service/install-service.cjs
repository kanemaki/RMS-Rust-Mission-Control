#!/usr/bin/env node
/**
 * Instala o agente do RMS como serviço do Windows.
 *
 * Requer PowerShell COMO ADMINISTRADOR (o registro de serviço escreve no
 * HKLM). Depois de instalar, o serviço já sobe automaticamente e passa a
 * iniciar junto com o Windows — sem "npm start".
 *
 * Uso:  node service\install-service.cjs
 * Remover depois:  node service\uninstall-service.cjs
 */
const { execSync } = require('node:child_process');
const path = require('node:path');
const Service = require('node-windows').Service;

// Pré-checagem amigável: "net session" só funciona elevado.
let isAdmin = false;
try {
  execSync('net session', { stdio: 'ignore' });
  isAdmin = true;
} catch {
  /* sem privilégio */
}
if (!isAdmin) {
  console.error('Este script precisa do PowerShell como Administrador.');
  console.error('Botão direito no PowerShell > "Executar como administrador" e rode de novo.');
  process.exit(1);
}

const agentRoot = path.join(__dirname, '..');

const svc = new Service({
  name: 'RMS Agent',
  id: 'RMSAgent',
  displayName: 'Rust Mission Control (Agente)',
  description:
    'Painel de administração dos servidores Rust (http://127.0.0.1:8090). ' +
    'Inicia com o Windows e reinicia sozinho se o agente cair.',
  // Entrada do agente (carrega src/index.js); define agent/ como pasta do wrapper.
  script: path.join(agentRoot, 'index.js'),
  workingdirectory: agentRoot,
  // Logs do wrapper (boot/queda do agente) junto dos logs do painel.
  logpath: path.join(agentRoot, 'data', 'logs'),
  nodeOptions: [], // sem o "--harmony" que o node-windows usa por padrão
  // Supervisão: se o agente cair, o wrapper reinicia com espera crescente
  // (até 10 reinícios em uma janela de 60 segundos).
  maxRestarts: 10,
  wait: 5,
  grow: 0.5,
});

svc.on('install', () => {
  console.log('Serviço "RMS Agent" instalado. Iniciando...');
  svc.start();
});

svc.on('alreadyinstalled', () => {
  console.log('O serviço "RMS Agent" já está instalado.');
  console.log('Para reinstalar: rode o uninstall e depois este script.');
  process.exit(0);
});

svc.on('start', () => {
  console.log('Serviço iniciado. Painel: http://127.0.0.1:8090');
  console.log('');
  console.log('Comandos úteis:');
  console.log('  Get-Service RMSAgent        # ver o estado');
  console.log('  Stop-Service RMSAgent       # parar (pare os servidores do jogo antes!)');
  console.log('  Start-Service RMSAgent      # iniciar de novo');
  process.exit(0);
});

svc.on('error', (error) => {
  console.error('Erro ao instalar o serviço:', error?.message || error);
  process.exit(1);
});

console.log('Instalando o serviço do Windows (RMS Agent)...');
svc.install();
