import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
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

async function setup(capabilities = {}) {
  const bridge = createBridge({ port: 0 });
  await bridge.ready;
  const server = createMcpServer(bridge);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { bridge, client, port: bridge.port() };
}

test('les origines acceptées : le site, ses prévisualisations, le développement local ; pas les autres pages', () => {
  assert.equal(allowedOrigin('https://modularsynth.app'), true);
  assert.equal(allowedOrigin('https://main-modularsynth.gregory-bruneau.workers.dev'), true);
  assert.equal(allowedOrigin('http://localhost:5173', false), false); // un autre projet local
  assert.equal(allowedOrigin('http://localhost:5173', true), true); // MODULARSYNTH_DEV=1
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

test('à la connexion, l’onglet apprend la version du serveur et lui donne ses outils (annoncés à l’IA, avec list_changed)', async () => {
  const { bridge, client, port } = await setup();
  let changed = 0;
  client.setNotificationHandler('notifications/tools/list_changed', () => void changed++);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'https://modularsynth.app' } });
  const announced = new Promise((resolve) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === 'server') resolve(msg.version);
      if (msg.method === 'list') ws.send(JSON.stringify({ id: msg.id, result: [{ name: 'brand_new', title: 'Brand new', description: 'A tool only the site knows.', inputSchema: { type: 'object' }, readOnly: true, destructive: false }] }));
    });
  });
  const version = JSON.parse((await import('node:fs')).readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
  assert.equal(await announced, version);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(changed >= 1);
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ['brand_new']);
  ws.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok((await client.listTools()).tools.some((t) => t.name === 'add_module')); // onglet parti : tools.json
  await bridge.close();
});

test('une réponse avec images arrive à l’IA en texte + images', async () => {
  const { bridge, client, port } = await setup();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'https://modularsynth.app' } });
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.method === 'call') ws.send(JSON.stringify({ id: msg.id, result: { text: 'hi', images: [{ data: 'AAAA', mimeType: 'image/png' }] } }));
  });
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 50));
  const r = await client.callTool({ name: 'look', arguments: {} });
  assert.deepEqual(r.content, [
    { type: 'text', text: 'hi' },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
  ]);
  ws.close();
  await bridge.close();
});

test('deux instances (Claude Desktop en lance deux) : la seconde relaie tout par la première, appels et autres demandes', async () => {
  const first = createBridge({ port: 0 });
  await first.ready;
  const port = first.port();
  const second = createBridge({ port });
  await second.ready;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'https://modularsynth.app' } });
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.method === 'call') ws.send(JSON.stringify({ id: msg.id, result: { text: `called ${msg.name}`, images: [{ data: 'AAAA', mimeType: 'image/png' }] } }));
    else if (msg.method === 'echo') ws.send(JSON.stringify({ id: msg.id, result: { echoed: msg.value } }));
  });
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 100));
  const viaSecond = await second.call('look', {});
  assert.deepEqual(viaSecond, { text: 'called look', images: [{ data: 'AAAA', mimeType: 'image/png' }] });
  assert.deepEqual(await second.request({ method: 'echo', value: 7 }, undefined, true), { echoed: 7 });
  ws.close();
  await second.close();
  await first.close();
});

test('prompts, instructions et ressources : embarqués sans onglet, relayés depuis l’onglet', async () => {
  const { bridge, client, port } = await setup();
  assert.match(client.getInstructions(), /1 V per octave/);
  const { prompts } = await client.listPrompts();
  assert.ok(prompts.some((p) => p.name === 'techno_loop'));
  const got = await client.getPrompt({ name: 'techno_loop', arguments: { tempo: '140' } });
  assert.match(got.messages[0].content.text, /140 BPM/);
  assert.deepEqual((await client.listResources()).resources.map((r) => r.uri), ['ui://modularsynth/player']);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'https://modularsynth.app' } });
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.method === 'resources') ws.send(JSON.stringify({ id: msg.id, result: [{ uri: 'modularsynth://patch/current', name: 'Current patch', mimeType: 'application/json' }] }));
    if (msg.method === 'resource') ws.send(JSON.stringify({ id: msg.id, result: { uri: msg.uri, mimeType: 'application/json', text: '{"name":"x"}' } }));
    if (msg.method === 'prompts' || msg.method === 'list') ws.send(JSON.stringify({ id: msg.id, error: 'not here' }));
  });
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok((await client.listResources()).resources.some((r) => r.uri === 'modularsynth://patch/current'));
  assert.equal((await client.readResource({ uri: 'modularsynth://patch/current' })).contents[0].text, '{"name":"x"}');
  ws.close();
  await bridge.close();
});

test('le paquet publié contient chaque fichier que le serveur lit au démarrage', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const { files } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  // package.json est toujours publié par npm.
  for (const [, f] of source.matchAll(/new URL\('\.\/([^']+)', import\.meta\.url\)/g)) if (f !== 'package.json') assert.ok(files.includes(f), `${f} manque dans "files"`);
});

test('MCP Apps : show_player pointe vers la carte, les outils de la carte lui sont réservés, la carte est une ressource HTML', async () => {
  const { bridge, client } = await setup({ extensions: { 'io.modelcontextprotocol/ui': {} } });
  const { tools } = await client.listTools();
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(by.show_player._meta.ui.resourceUri, 'ui://modularsynth/player');
  assert.deepEqual(by.player_state._meta.ui.visibility, ['app']);
  assert.equal(by.describe_patch._meta, undefined);
  assert.ok((await client.listResources()).resources.some((r) => r.uri === 'ui://modularsynth/player'));
  const card = (await client.readResource({ uri: 'ui://modularsynth/player' })).contents[0];
  assert.equal(card.mimeType, 'text/html;profile=mcp-app');
  assert.match(card.text, /^<!doctype html>/);
  assert.doesNotMatch(card.text, /<script[^>]+src=/);
  await bridge.close();
});

test('versions mêlées : une instance d’avant 1.6.0 derrière une 1.6.0 reçoit du texte, pas un objet', async () => {
  const first = createBridge({ port: 0 });
  await first.ready;
  const port = first.port();
  const tab = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'https://modularsynth.app' } });
  tab.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.method === 'call') tab.send(JSON.stringify({ id: m.id, result: { text: 'photo', images: [{ data: 'AAAA', mimeType: 'image/png' }] } }));
  });
  await new Promise((r) => tab.on('open', r));
  // Une instance 1.5.0 : se présente comme relais et envoie { id, name, args } sans méthode.
  const old = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { 'x-modularsynth-relay': '1' } });
  await new Promise((r) => old.on('open', r));
  const answer = new Promise((r) => old.on('message', (d) => r(JSON.parse(String(d)))));
  old.send(JSON.stringify({ id: 9, name: 'look', args: {} }));
  assert.deepEqual(await answer, { id: 9, result: 'photo' });
  old.close();
  tab.close();
  await first.close();
});

test('versions mêlées : derrière une instance d’avant 1.6.0 (qui ignore prompts et ressources), le repli arrive vite', async () => {
  // Une fausse instance primaire 1.5.0 : tient le port, accepte le relais, ne répond pas aux nouvelles demandes.
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.on('listening', r));
  const port = wss.address().port;
  const bridge = createBridge({ port });
  await bridge.ready;
  const t0 = Date.now();
  const list = await bridge.prompts();
  assert.ok(list.some((p) => p.name === 'techno_loop'));
  assert.deepEqual(await bridge.resources(), []);
  assert.ok(Date.now() - t0 < 6000, `${Date.now() - t0} ms`);
  await bridge.close();
  wss.close();
});

test('outils de la carte : seulement pour un client qui déclare MCP Apps', async () => {
  const bridge = createBridge({ port: 0 });
  await bridge.ready;
  const names = async (capabilities) => {
    const server = createMcpServer(bridge);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities });
    await Promise.all([server.connect(a), client.connect(b)]);
    return (await client.listTools()).tools.map((t) => t.name);
  };
  const plain = await names({});
  assert.ok(!plain.includes('player_state') && !plain.includes('player_set') && !plain.includes('player_look'));
  assert.ok(plain.includes('show_player'));
  const apps = await names({ extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } });
  assert.ok(apps.includes('player_state') && apps.includes('player_set'));
  await bridge.close();
});

test('outils de la carte : un client sans MCP Apps ne peut pas les appeler par leur nom non plus (son geste passerait pour celui de la personne)', async () => {
  const { bridge, client } = await setup({});
  const r = await client.callTool({ name: 'player_set', arguments: { knob: 'vcf:cutoff', value: 300 } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Unknown tool/);
  await bridge.close();
});

test('prompt sans son argument obligatoire : une erreur claire, pas un texte avec un trou', async () => {
  const { bridge, client } = await setup();
  await assert.rejects(client.getPrompt({ name: 'remix_preset', arguments: {} }), /preset/);
  await bridge.close();
});
