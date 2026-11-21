/**
 * Entrada do agente usada pelo serviço do Windows (agent/service).
 *
 * O node-windows grava os arquivos do wrapper (exe + xml + logs de boot) em uma
 * pasta "daemon" ao lado do script informado. Apontando para este arquivo na
 * raiz do agent/, os arquivos ficam em agent/daemon — fora do código em src/.
 * A única função é carregar o agente de verdade, em src/index.js.
 */
import './src/index.js';
