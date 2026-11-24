import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(here, '..');
const specFile = path.resolve(agentRoot, '..', 'docs', 'openapi.json');
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function operations() {
  const list = [];
  for (const [routePath, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      if (item[method]) list.push({ routePath, method, operation: item[method] });
    }
  }
  return list;
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const value of Object.values(node)) walk(value, visit);
}

test('especificação OpenAPI é válida e cobre todas as rotas do agente', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.info?.title);
  assert.ok(spec.info?.version);
  assert.ok(Array.isArray(spec.servers) && spec.servers.length > 0);

  const source = fs.readFileSync(path.join(agentRoot, 'src', 'api.js'), 'utf8');
  const routes = new Set();
  for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
    routes.add(`${match[1].toUpperCase()} ${match[2].replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`);
  }
  const documented = new Set(operations().map(({ method, routePath }) => `${method.toUpperCase()} ${routePath}`));

  assert.deepEqual([...routes].filter((route) => !documented.has(route)), [], 'rotas sem documentação');
  assert.deepEqual([...documented].filter((route) => !routes.has(route)), [], 'rotas documentadas que não existem');
});

test('todos os $ref apontam para componentes existentes', () => {
  const refs = [];
  walk(spec, (node) => {
    if (typeof node.$ref === 'string') refs.push(node.$ref);
  });
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    assert.ok(ref.startsWith('#/'), `referência externa não suportada: ${ref}`);
    const target = ref
      .slice(2)
      .split('/')
      .reduce((node, key) => (node == null ? undefined : node[key]), spec);
    assert.ok(target, `$ref quebrado: ${ref}`);
  }
});

test('cada operação tem id único, tag, papel e resposta de sucesso', () => {
  const ids = new Set();
  const tags = new Set(spec.tags.map((tag) => tag.name));
  for (const { method, routePath, operation } of operations()) {
    const label = `${method.toUpperCase()} ${routePath}`;
    assert.ok(operation.operationId, `${label} sem operationId`);
    assert.ok(!ids.has(operation.operationId), `operationId duplicado: ${operation.operationId}`);
    ids.add(operation.operationId);
    assert.ok(Array.isArray(operation.tags) && operation.tags.length > 0, `${label} sem tag`);
    for (const tag of operation.tags) assert.ok(tags.has(tag), `${label} usa tag não declarada: ${tag}`);
    assert.ok(operation.summary, `${label} sem summary`);
    assert.ok(operation['x-rmc-role'], `${label} sem x-rmc-role`);
    const success = Object.keys(operation.responses ?? {}).filter((code) => code.startsWith('2'));
    assert.ok(success.length > 0, `${label} sem resposta 2xx`);
    if (operation['x-rmc-role'] === 'public') {
      assert.ok(Array.isArray(operation.security), `${label} pública precisa declarar security`);
      const schemes = operation.security.flatMap((entry) => Object.keys(entry));
      assert.ok(!schemes.includes('sessionCookie'), `${label} pública não pode exigir sessão`);
    }
  }
});

test('GET /api/openapi.json é público e devolve a especificação', async (t) => {
  process.env.RMC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rmc-openapi-'));
  const express = (await import('express')).default;
  const { createApi } = await import('../src/api.js');

  const app = express();
  app.use(express.json());
  app.use('/api', createApi({ version: '0.1.0', port: 8090 }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/openapi.json`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);

  const body = await response.json();
  assert.equal(body.openapi, '3.1.0');
  assert.deepEqual(Object.keys(body.paths).sort(), Object.keys(spec.paths).sort());
});
