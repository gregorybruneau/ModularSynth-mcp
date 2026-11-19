#!/usr/bin/env node
// Serveur MCP de ModularSynth : relaie les outils de l'IA (Claude Desktop, Claude Code…) vers l'onglet
// ModularSynth ouvert, par un WebSocket sur 127.0.0.1. Rien ne quitte la machine.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { WebSocket, WebSocketServer } from 'ws';

export const DEFAULT_PORT = 27900;
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
/** Les outils du site (nom, description, schéma), générés depuis son code : `npm run mcp:tools`. */
const TOOLS = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));
/** Prompts (gabarits `{{argument}}`) et instructions du site, servis tant qu'aucun onglet n'est connecté. */
const PROMPTS = JSON.parse(readFileSync(new URL('./prompts.json', import.meta.url), 'utf8'));
const INSTRUCTIONS = readFileSync(new URL('./instructions.txt', import.meta.url), 'utf8');
/** La carte ModularSynth (MCP Apps) : un fichier HTML autonome, construit depuis le site. */
const PLAYER_URI = 'ui://modularsynth/player';
const PLAYER = readFileSync(new URL('./app/player.html', import.meta.url), 'utf8');
const PLAYER_RESOURCE = { uri: PLAYER_URI, name: 'ModularSynth player', mimeType: 'text/html;profile=mcp-app', description: 'Play/stop and a few knobs of the ModularSynth tab, in the conversation.' };

/** Le texte d'un prompt de prompts.json, arguments remplacés (valeur par défaut si absente). */
export function renderLocalPrompt(name, args = {}) {
  const p = PROMPTS.find((x) => x.name === name);
  if (!p) throw new Error(`Unknown prompt "${name}".`);
  const missing = p.arguments.find((a) => a.required && !args[a.name] && a.default === undefined);
  if (missing) throw new Error(`The prompt "${name}" needs the argument "${missing.name}" (${missing.description}).`);
  return p.template.replace(/\{\{(\w+)\}\}/g, (_, k) => args[k] ?? p.arguments.find((a) => a.name === k)?.default ?? '');
}
const CALL_TIMEOUT_MS = 15_000;
/** Listes de prompts et de ressources : une instance d'avant 1.6.0 n'y répond jamais, on n'attend pas 15 s. */
const LIST_TIMEOUT_MS = 2000;
/** Un patch décrit tient dans 1 Mo ; les images de `look` (base64) demandent plus. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** Port occupé : on réessaie (Claude Desktop lance l'extension deux fois de suite au démarrage). */
const LISTEN_RETRY_MS = 1000;
/**
 * En-tête d'une autre instance de ce serveur (Claude Desktop en lance deux) : elle passe par celle qui
 * tient le port. Une page web ne peut pas choisir ses en-têtes WebSocket : elle ne peut pas s'en servir.
 */
const RELAY_HEADER = 'x-modularsynth-relay';

const NOT_CONNECTED = 'ModularSynth is not connected. Ask the user to open https://modularsynth.app, click "AI" in the top bar, and check "Connect this tab to the server".';

/**
 * Le site et ses prévisualisations Cloudflare (sur le compte du projet seulement : n'importe qui peut
 * nommer un Worker « modularsynth » sur son propre compte). Le développement local (localhost) seulement
 * avec MODULARSYNTH_DEV=1 : sinon n'importe quel projet local ouvert dans le navigateur pourrait se faire
 * passer pour l'onglet et répondre à l'IA.
 */
export function allowedOrigin(origin, dev = process.env.MODULARSYNTH_DEV === '1') {
  if (typeof origin !== 'string') return false;
  return (
    /^https:\/\/(www\.)?modularsynth\.app$/.test(origin) ||
    /^https:\/\/([a-z0-9-]+-)?modularsynth\.gregory-bruneau\.workers\.dev$/.test(origin) ||
    (dev && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
  );
}

/** Réponse riche de la page (1.6.0) : du texte et des images en base64. */
const richResult = (r) =>
  r !== null && typeof r === 'object' && typeof r.text === 'string' && Array.isArray(r.images) && r.images.every((i) => i && typeof i.data === 'string' && /^image\/(png|jpeg)$/.test(i.mimeType));

/** Liste d'outils envoyée par l'onglet : gardée seulement si elle a la bonne forme. */
const validTools = (list) =>
  Array.isArray(list) && list.length > 0 && list.every((t) => t && typeof t.name === 'string' && typeof t.description === 'string' && t.inputSchema && typeof t.inputSchema === 'object');

const parse = (data) => {
  try {
    const msg = JSON.parse(String(data));
    return msg && typeof msg === 'object' ? msg : null;
  } catch {
    return null;
  }
};

/**
 * Le pont vers l'onglet : un seul onglet à la fois. L'instance qui tient le port parle à l'onglet ; une
 * autre instance (port déjà pris par un serveur ModularSynth) passe par elle, et reprend le port s'il se libère.
 */
export function createBridge({ port = Number(process.env.MODULARSYNTH_PORT) || DEFAULT_PORT } = {}) {
  let tab = null;
  /** Outils de l'onglet connecté (ceux du site en ligne, plus récents que tools.json) ; null sans onglet. */
  let tabTools = null;
  const toolsChanged = new Set();
  let relay = null; // instance secondaire : la connexion vers celle qui tient le port
  let next = 1;
  let failure = null;
  let closed = false;
  let retry = null;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const pending = new Map();
  const http = createServer();
  const wss = new WebSocketServer({
    server: http,
    maxPayload: MAX_MESSAGE_BYTES,
    verifyClient: ({ origin, req }) => req.headers[RELAY_HEADER] === '1' || allowedOrigin(origin),
  });
  wss.on('error', () => {}); // ws relaie les erreurs du serveur http : traitées ci-dessous
  const listen = () => {
    if (!closed) http.listen(port, '127.0.0.1');
  };
  const later = () => {
    if (!closed) retry = setTimeout(listen, LISTEN_RETRY_MS);
  };
  http.on('listening', () => {
    failure = null;
    resolveReady();
  });
  http.on('error', (e) => {
    if (e.code === 'EADDRINUSE') return join();
    failure = `ModularSynth MCP server error: ${e.message}`;
    process.stderr.write(`${failure}\n`);
    resolveReady();
  });
  listen();

  /** Port déjà pris : si c'est une autre instance ModularSynth, on passe par elle. */
  function join() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { [RELAY_HEADER]: '1' },
      maxPayload: MAX_MESSAGE_BYTES,
      handshakeTimeout: 2000, // un programme étranger peut ne jamais répondre
    });
    ws.on('open', () => {
      relay = ws;
      failure = null;
      resolveReady();
    });
    ws.on('error', () => {
      failure = `Port ${port} is busy: another program uses it (set MODULARSYNTH_PORT to another port). On Windows with WSL mirrored networking, a port once used inside WSL stays reserved until "wsl --shutdown".`;
    });
    answers(ws, 'The other ModularSynth server stopped.');
    ws.on('close', () => {
      if (relay === ws) relay = null;
      resolveReady();
      later(); // l'autre instance s'est arrêtée (ou n'en était pas une) : on retente le port
    });
  }

  /** Les réponses reçues sur `ws` règlent les appels en cours ; s'il se ferme, ses appels échouent aussitôt. */
  function answers(ws, closedMessage) {
    ws.on('message', (data) => {
      const msg = parse(data);
      const p = msg && pending.get(msg.id);
      if (!p) return; // « hello », ou réponse arrivée trop tard
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error !== undefined) p.reject(new Error(String(msg.error)));
      else if (typeof msg.result !== 'string' && !p.raw && !richResult(msg.result)) p.reject(new Error('ModularSynth sent an unexpected answer.'));
      else p.resolve(msg.result);
    });
    ws.on('close', () => {
      for (const [id, p] of pending) {
        if (p.ws !== ws) continue;
        clearTimeout(p.timer);
        p.reject(new Error(closedMessage));
        pending.delete(id);
      }
    });
  }

  wss.on('connection', (ws, req) => {
    if (req.headers[RELAY_HEADER] === '1') {
      // Une autre instance : ses appels passent par notre onglet.
      ws.on('message', async (data) => {
        const msg = parse(data);
        if (!msg || msg.id === undefined) return;
        // L'autre instance demande la liste des outils : celle de notre onglet, à défaut la nôtre.
        if (msg.method === 'list') return ws.send(JSON.stringify({ id: msg.id, result: tabTools ?? TOOLS }));
        // Toute autre demande (appel d'outil, prompts, ressources…) part telle quelle vers l'onglet ;
        // une instance d'avant 1.6.0 envoyait { name, args } sans méthode.
        const { id, ...body } = msg;
        try {
          const result = await request(body.method ? body : { method: 'call', ...body }, tab, true);
          ws.send(
            JSON.stringify({
              id,
              // Une instance d'avant 1.6.0 n'accepte que du texte : on lui garde le texte d'une réponse riche.
              result: !body.method && richResult(result) ? result.text : result,
            }),
          );
        } catch (e) {
          if (ws.readyState === ws.OPEN)
            ws.send(
              JSON.stringify({
                id: msg.id,
                error: e instanceof Error ? e.message : String(e),
              }),
            );
        }
      });
      return;
    }
    // Un seul onglet : le premier garde la main (sinon deux onglets se la voleraient sans fin).
    if (tab && tab.readyState === tab.OPEN) {
      ws.close(4000, 'Another ModularSynth tab is already connected.');
      return;
    }
    tab = ws;
    answers(ws, 'The ModularSynth tab was closed.');
    // La page apprend notre version (elle prévient l'IA si nous sommes en retard), puis nous donne ses
    // outils : ceux du site en ligne, même s'il est plus récent que ce serveur.
    ws.send(JSON.stringify({ type: 'server', version: VERSION }));
    request({ method: 'list' }, ws, true)
      .then((list) => {
        if (tab !== ws || !validTools(list)) return;
        tabTools = list;
        for (const f of toolsChanged) f();
      })
      .catch(() => {});
    ws.on('close', () => {
      if (tab !== ws) return;
      tab = null;
      tabTools = null;
    });
  });

  /** Envoie une demande à `to` (l'onglet, ou l'instance qui le tient) ; `raw` : réponse autre que du texte. */
  function request(body, to = relay ?? tab, raw = false, timeout = CALL_TIMEOUT_MS) {
    if (!to) return Promise.reject(new Error(failure ?? NOT_CONNECTED));
    const id = next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('ModularSynth did not answer in time.'));
      }, timeout);
      pending.set(id, { resolve, reject, timer, ws: to, raw });
      to.send(JSON.stringify({ id, ...body }));
    });
  }

  const call = (name, args) => request({ method: 'call', name, args });

  /** Prompts de l'onglet s'il est là (ou de l'instance qui le tient), sinon prompts.json. */
  async function prompts() {
    if (!relay && !tab) return PROMPTS;
    // Une instance d'avant 1.6.0 ignore cette demande : repli rapide sur prompts.json.
    const list = await request({ method: 'prompts' }, undefined, true, LIST_TIMEOUT_MS).catch(() => null);
    return Array.isArray(list) ? list : PROMPTS;
  }

  async function prompt(name, args) {
    if (!relay && !tab) return renderLocalPrompt(name, args);
    return request({ method: 'prompt', name, args });
  }

  /** Les ressources viennent de la page : sans onglet, aucune. */
  async function resources() {
    if (!relay && !tab) return [];
    const list = await request({ method: 'resources' }, undefined, true, LIST_TIMEOUT_MS).catch(() => null);
    return Array.isArray(list) ? list : [];
  }

  const resource = (uri) => request({ method: 'resource', uri }, undefined, true);

  /** Les outils à annoncer : ceux de l'onglet s'il est là (directement ou par l'autre instance), sinon tools.json. */
  async function tools() {
    if (relay) {
      const list = await request({ method: 'list' }, relay, true).catch(() => null);
      return validTools(list) ? list : TOOLS;
    }
    return tabTools ?? TOOLS;
  }

  return {
    ready,
    port: () => http.address()?.port ?? port,
    call,
    request,
    tools,
    prompts,
    prompt,
    resources,
    resource,
    /** Prévenu quand l'onglet apporte sa liste d'outils. */
    onToolsChanged: (f) => toolsChanged.add(f),
    close: () =>
      new Promise((resolve) => {
        closed = true;
        clearTimeout(retry);
        relay?.terminate();
        for (const c of wss.clients) c.terminate();
        wss.close();
        if (http.listening) http.close(() => resolve());
        else resolve();
      }),
  };
}

/** Le serveur MCP : la liste des outils est toujours là (celle de l'onglet dès qu'il est connecté) ; chaque appel part vers l'onglet. */
export function createMcpServer(bridge) {
  const server = new Server(
    { name: 'modularsynth', version: VERSION },
    { capabilities: { tools: { listChanged: true }, prompts: { listChanged: true }, resources: { listChanged: true } }, instructions: INSTRUCTIONS },
  );
  // Un onglet arrive : ses outils, prompts et ressources remplacent ceux embarqués.
  bridge.onToolsChanged?.(() => {
    void server.sendToolListChanged().catch(() => {});
    void server.sendPromptListChanged().catch(() => {});
    void server.sendResourceListChanged().catch(() => {});
  });
  server.setRequestHandler('prompts/list', async () => ({
    prompts: (bridge.prompts ? await bridge.prompts() : PROMPTS).map((p) => ({
      name: p.name,
      title: p.title,
      description: p.description,
      arguments: p.arguments.map(({ name, description, required }) => ({ name, description, required: !!required })),
    })),
  }));
  server.setRequestHandler('prompts/get', async (req) => {
    const name = req.params.name;
    const text = bridge.prompt ? await bridge.prompt(name, req.params.arguments ?? {}) : renderLocalPrompt(name, req.params.arguments);
    const p = PROMPTS.find((x) => x.name === name);
    return { ...(p && { description: p.description }), messages: [{ role: 'user', content: { type: 'text', text } }] };
  });
  server.setRequestHandler('resources/list', async () => ({ resources: [PLAYER_RESOURCE, ...(bridge.resources ? await bridge.resources() : [])] }));
  server.setRequestHandler('resources/read', async (req) => ({
    contents: [req.params.uri === PLAYER_URI ? { uri: PLAYER_URI, mimeType: PLAYER_RESOURCE.mimeType, text: PLAYER } : await bridge.resource(req.params.uri)],
  }));
  // Outils réservés à la carte : seulement pour un client qui affiche les cartes (MCP Apps). Un autre les
  // donnerait au modèle, dont les gestes passeraient alors pour ceux de la personne : ni listés, ni appelables.
  const visible = (t) => !t.ui?.visibility || t.ui.visibility.includes('model') || !!server.getClientCapabilities()?.extensions?.['io.modelcontextprotocol/ui'];
  server.setRequestHandler('tools/list', async () => ({
    tools: (bridge.tools ? await bridge.tools() : TOOLS)
      .filter(visible)
      .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      title: t.title,
      annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: t.destructive, openWorldHint: false },
      // MCP Apps : interface affichée par l'outil, ou outil réservé à l'interface.
      ...(t.ui && { _meta: { ui: t.ui } }),
    })),
  }));
  server.setRequestHandler('tools/call', async (req) => {
    try {
      const tool = TOOLS.find((t) => t.name === req.params.name);
      if (tool && !visible(tool)) throw new Error(`Unknown tool "${req.params.name}".`);
      const result = await bridge.call(req.params.name, req.params.arguments ?? {});
      if (typeof result === 'string') return { content: [{ type: 'text', text: result }] };
      return { content: [{ type: 'text', text: result.text }, ...result.images.map(({ data, mimeType }) => ({ type: 'image', data, mimeType }))] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
        isError: true,
      };
    }
  });
  return server;
}

// Lancé directement (npx modularsynth-mcp, extension Claude Desktop) : stdio vers l'IA.
if (process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:fs')).realpathSync(process.argv[1])) {
  const bridge = createBridge();
  await bridge.ready;
  await createMcpServer(bridge).connect(new StdioServerTransport());
  // L'application d'IA ferme notre entrée : on libère le port et on s'arrête (pas de processus orphelin).
  const quit = () => void bridge.close().then(() => process.exit(0));
  process.stdin.on('end', quit);
  process.stdin.on('close', quit);
}
