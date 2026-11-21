#!/usr/bin/env node
/**
 * Remove o serviço do Windows do agente do RMS. Para o serviço caso esteja
 * rodando e apaga o registro (os arquivos do wrapper em agent/daemon também
 * são removidos).
 *
 * Requer PowerShell COMO ADMINISTRADOR.
 * Uso:  node service\uninstall-service.cjs
 */
const { execSync } = require('node:child_process');
const Service = require('node-windows').Service;

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

const svc = new Service({
  name: 'RMS Agent',
  id: 'RMSAgent',
  script: require('node:path').join(__dirname, '..', 'index.js'),
});

svc.on('uninstall', () => {
  console.log('Serviço "RMS Agent" removido.');
  process.exit(0);
});

svc.on('alreadyuninstalled', () => {
  console.log('O serviço "RMS Agent" não estava instalado.');
  process.exit(0);
});

svc.on('error', (error) => {
  console.error('Erro ao remover o serviço:', error?.message || error);
  process.exit(1);
});

console.log('Removendo o serviço do Windows (RMS Agent)...');
svc.uninstall();
