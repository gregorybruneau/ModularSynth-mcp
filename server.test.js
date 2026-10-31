import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { allowedOrigin, createBridge, createMcpServer } from './server.js';

/** Un faux onglet ModularSynth : répond aux appels comme le ferait la page. */
function fakeTab(port, origin = 'https://modularsynth.app') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin } });
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.method !== 'call') return;
    if (msg.name === 'add_module') ws.send(JSON.stringify({ id: msg.id, result: JSON.stringify({ id: 'm1', type: msg.args.type }) }));
    else ws.send(JSON.stringify({ id: msg.id, error: `Unknown tool "${msg.name}".` }));
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function setup() {
  const bridge = createBridge({ port: 0 });
  await bridge.ready;
  const server = createMcpServer(bridge);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { bridge, client, port: bridge.port() };
}

test('les origines acceptées : le site, ses prévisualisations, le développement local ; pas les autres pages', () => {
  assert.equal(allowedOrigin('https://modularsynth.app'), true);
  assert.equal(allowedOrigin('https://main-modularsynth.gregory-bruneau.workers.dev'), true);
  assert.equal(allowedOrigin('http://localhost:5173'), true);
  assert.equal(allowedOrigin('https://evil.example'), false);
  assert.equal(allowedOrigin('https://modularsynth.app.evil.example'), false);
  assert.equal(allowedOrigin(undefined), false);
});

test('l’IA voit tous les outils, même sans onglet ; un appel sans onglet explique quoi faire', async () => {
  const { bridge, client } = await setup();
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === 'add_module'));
  assert.equal(tools.find((t) => t.name === 'describe_patch').annotations.readOnlyHint, true);
  const r = await client.callTool({ name: 'add_module', arguments: { type: 'vco' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /open https:\/\/modularsynth\.app/i);
  await bridge.close();
});

test('un appel est relayé à l’onglet, et sa réponse (ou son erreur) revient à l’IA', async () => {
  const { bridge, client, port } = await setup();
  const tab = await fakeTab(port);
  await new Promise((r) => setTimeout(r, 50));
  const ok = await client.callTool({ name: 'add_module', arguments: { type: 'vco' } });
  assert.equal(ok.isError, undefined);
  assert.match(ok.content[0].text, /"type":"vco"/);
  const ko = await client.callTool({ name: 'undo', arguments: {} });
  assert.equal(ko.isError, true);
  tab.close();
  await bridge.close();
});

test('une page d’une autre origine ne peut pas se faire passer pour le synthé', async () => {
  const { bridge, port } = await setup();
  await assert.rejects(fakeTab(port, 'https://evil.example'));
  await bridge.close();
});

test('un Worker Cloudflare d’un autre compte nommé « modularsynth » est refusé', () => {
  assert.equal(allowedOrigin('https://modularsynth.attacker.workers.dev'), false);
  assert.equal(allowedOrigin('https://main-modularsynth.attacker.workers.dev'), false);
  assert.equal(allowedOrigin('https://modularsynth.gregory-bruneau.workers.dev'), true);
});

test('un message illisible ou « null » ne fait pas tomber le serveur', async () => {
  const { bridge, client, port } = await setup();
  const tab = await fakeTab(port);
  tab.send('null');
  tab.send('42');
  tab.send('{oups');
  await new Promise((r) => setTimeout(r, 50));
  const ok = await client.callTool({ name: 'add_module', arguments: { type: 'vco' } });
  assert.match(ok.content[0].text, /"type":"vco"/);
  tab.close();
  await bridge.close();
});

test('un deuxième onglet est refusé tant que le premier est connecté ; un appel en cours échoue tout de suite si son onglet se ferme', async () => {
  const { bridge, client, port } = await setup();
  const first = await fakeTab(port);
  const second = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'https://modularsynth.app' } });
  const code = await new Promise((resolve) => second.on('close', (c) => resolve(c)));
  assert.equal(code, 4000);
  const ok = await client.callTool({ name: 'add_module', arguments: { type: 'vco' } });
  assert.match(ok.content[0].text, /"type":"vco"/);
  // Un onglet muet, fermé pendant l'appel : l'IA le sait aussitôt, sans attendre 15 s.
  first.removeAllListeners('message');
  const started = Date.now();
  const pending = client.callTool({ name: 'add_module', arguments: { type: 'vco' } });
  setTimeout(() => first.close(), 50);
  const ko = await pending;
  assert.equal(ko.isError, true);
  assert.ok(Date.now() - started < 2000);
  await bridge.close();
});

test('le serveur s’arrête quand l’application d’IA ferme son entrée (pas de processus orphelin qui garde le port)', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname], { env: { ...process.env, MODULARSYNTH_PORT: '47833' }, stdio: ['pipe', 'ignore', 'ignore'] });
  await new Promise((r) => setTimeout(r, 500));
  child.stdin.end();
  const code = await Promise.race([new Promise((r) => child.on('exit', (c) => r(c))), new Promise((r) => setTimeout(() => r('toujours vivant'), 3000))]);
  if (code === 'toujours vivant') child.kill();
  assert.equal(code, 0);
});

test('port occupé au démarrage (Claude Desktop relance l’extension aussitôt) : le serveur le reprend dès qu’il se libère', async () => {
  const { createServer } = await import('node:http');
  const squatter = createServer();
  await new Promise((r) => squatter.listen(0, '127.0.0.1', r));
  const port = squatter.address().port;
  const bridge = createBridge({ port });
  await bridge.ready;
  const server = createMcpServer(bridge);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const busy = await client.callTool({ name: 'add_module', arguments: { type: 'vco' } });
  assert.match(busy.content[0].text, /busy/i);
  await new Promise((r) => squatter.close(r));
  await new Promise((r) => setTimeout(r, 1500));
  const tab = await fakeTab(port);
  await new Promise((r) => setTimeout(r, 50));
  const ok = await client.callTool({ name: 'add_module', arguments: { type: 'vco' } });
  assert.match(ok.content[0].text, /"type":"vco"/);
  tab.close();
  await bridge.close();
});

test('deux instances (Claude Desktop en lance deux) : la seconde passe par la première ; si la première s’arrête, elle prend le relais', async () => {
  const first = await setup();
  const port = first.port;
  const second = createBridge({ port });
  await second.ready;
  const server = createMcpServer(second);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const tab = await fakeTab(port);
  await new Promise((r) => setTimeout(r, 50));
  const viaFirst = await client.callTool({ name: 'add_module', arguments: { type: 'vco' } });
  assert.match(viaFirst.content[0].text, /"type":"vco"/);
  const err = await client.callTool({ name: 'undo', arguments: {} });
  assert.equal(err.isError, true);
  assert.match(err.content[0].text, /Unknown tool/);
  // Une page web ne peut pas se faire passer pour un relais (elle ne choisit pas ses en-têtes, et son origine est vérifiée).
  await assert.rejects(fakeTab(port, 'https://evil.example'));
  tab.close();
  await first.bridge.close();
  await new Promise((r) => setTimeout(r, 1500));
  const tab2 = await fakeTab(port);
  await new Promise((r) => setTimeout(r, 50));
  const viaSecond = await client.callTool({ name: 'add_module', arguments: { type: 'vcf' } });
  assert.match(viaSecond.content[0].text, /"type":"vcf"/);
  tab2.close();
  await second.close();
});
