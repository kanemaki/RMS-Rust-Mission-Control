/**
 * Patches do node-windows 1.0.0-beta.8, aplicados após o npm install:
 *
 * 1. Remove um console.log de debug deixado no gerador do XML do serviço
 *    (lib/winsw.js), que cospe o objeto de configuração no terminal durante
 *    a instalação.
 * 2. Corrige o id do serviço (lib/daemon.js): o beta.8 registra o serviço do
 *    Windows como "rmsagent.exe" em vez de "rmsagent" — os comandos ficam
 *    esquisitos (Get-Service rmsagent.exe).
 *
 * Cada correção não faz nada se a linha não existir (versão futura corrigida,
 * por exemplo). Roda automaticamente pelo "postinstall" do package.json.
 */
const fs = require('node:fs');
const path = require('node:path');

const pkgDir = path.join(__dirname, '..', 'node_modules', 'node-windows');

// [arquivo, linha de debug a remover, linha trocada por, correção]
const fixes = [
  {
    file: path.join(pkgDir, 'lib', 'winsw.js'),
    remove: "console.log({loc: 'winsw.js ~line 77', xml, config})",
    from: null,
    to: null,
  },
  {
    file: path.join(pkgDir, 'lib', 'daemon.js'),
    from: 'id: this._exe,',
    to: 'id: this.id,',
  },
];

for (const fix of fixes) {
  try {
    let code = fs.readFileSync(fix.file, 'utf8');
    const original = code;
    if (fix.remove && code.includes(fix.remove)) {
      code = code.split(fix.remove + '\n').join('').split(fix.remove).join('');
    }
    if (fix.from && code.includes(fix.from)) {
      code = code.split(fix.from).join(fix.to);
    }
    if (code !== original) {
      fs.writeFileSync(fix.file, code);
      console.log(`node-windows: patch aplicado em ${path.basename(fix.file)}.`);
    }
  } catch {
    /* node-windows não instalado ou sem permissão: ignora */
  }
}
