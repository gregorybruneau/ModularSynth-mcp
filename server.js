#!/usr/bin/env node
// Serveur MCP de ModularSynth : relaie les outils de l'IA (Claude Desktop, Claude Code…) vers l'onglet
// ModularSynth ouvert, par un WebSocket sur 127.0.0.1. Rien ne quitte la machine.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocket, WebSocketServer } from 'ws';

export const DEFAULT_PORT = 27900;
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
/** Les outils du site (nom, description, schéma), générés depuis son code : `npm run mcp:tools`. */
const TOOLS = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));
const CALL_TIMEOUT_MS = 15_000;
/** Un patch décrit tient largement dans 1 Mo. */
const MAX_MESSAGE_BYTES = 1024 * 1024;
/** Port occupé : on réessaie (Claude Desktop lance l'extension deux fois de suite au démarrage). */
const LISTEN_RETRY_MS = 1000;
/**
 * En-tête d'une autre instance de ce serveur (Claude Desktop en lance deux) : elle passe par celle qui
 * tient le port. Une page web ne peut pas choisir ses en-têtes WebSocket : elle ne peut pas s'en servir.
 */
const RELAY_HEADER = 'x-modularsynth-relay';

const NOT_CONNECTED = 'ModularSynth is not connected. Ask the user to open https://modularsynth.app, click "AI" in the top bar, and check "Connect this tab to the server".';

/**
 * Le site, ses prévisualisations Cloudflare (sur le compte du projet seulement : n'importe qui peut
 * nommer un Worker « modularsynth » sur son propre compte), le développement local : rien d'autre.
 */
export function allowedOrigin(origin) {
  if (typeof origin !== 'string') return false;
  return (
    /^https:\/\/(www\.)?modularsynth\.app$/.test(origin) ||
    /^https:\/\/([a-z0-9-]+-)?modularsynth\.gregory-bruneau\.workers\.dev$/.test(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  );
}

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
      else if (typeof msg.result !== 'string') p.reject(new Error('ModularSynth sent an unexpected answer.'));
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
        if (!msg || typeof msg.name !== 'string') return;
        try {
          ws.send(
            JSON.stringify({
              id: msg.id,
              result: await call(msg.name, msg.args),
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
    ws.on('close', () => {
      if (tab === ws) tab = null;
    });
  });

  function call(name, args) {
    const to = relay ?? tab;
    if (!to) return Promise.reject(new Error(failure ?? NOT_CONNECTED));
    const id = next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('ModularSynth did not answer in time.'));
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer, ws: to });
      to.send(JSON.stringify({ id, method: 'call', name, args }));
    });
  }

  return {
    ready,
    port: () => http.address()?.port ?? port,
    call,
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

/** Le serveur MCP : la liste des outils est toujours là ; chaque appel part vers l'onglet. */
export function createMcpServer(bridge) {
  const server = new Server({ name: 'modularsynth', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      title: t.title,
      annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: t.destructive, openWorldHint: false },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const text = await bridge.call(req.params.name, req.params.arguments ?? {});
      return { content: [{ type: 'text', text }] };
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
