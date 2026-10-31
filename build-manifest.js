// Manifeste de l'extension Claude Desktop (MCP Bundle), tiré de package.json et des outils du site.
import { readFileSync, writeFileSync } from 'node:fs';

const read = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8'));
const pkg = read('./package.json');
const tools = read('./tools.json');

const manifest = {
  manifest_version: '0.2',
  name: 'modularsynth',
  display_name: 'ModularSynth',
  version: pkg.version,
  description: 'Build and play patches in ModularSynth, the free modular synthesizer in your browser.',
  long_description:
    'Lets Claude add modules, patch cables, turn knobs, write sequences and play notes in the ModularSynth tab open in your browser. Open https://modularsynth.app, click “AI” in the top bar and check “Connect this tab to the server”. Everything stays on your computer: the extension only talks to that tab over 127.0.0.1.',
  author: { name: 'Gregory Bruneau', email: 'gregory.bruneau@gmail.com', url: 'https://github.com/gregorybruneau' },
  repository: { type: 'git', url: 'https://github.com/gregorybruneau/ModularSynth-mcp' },
  support: 'https://github.com/gregorybruneau/ModularSynth-mcp/issues',
  homepage: 'https://modularsynth.app/',
  // La favicon du site en PNG 512 px (rendue depuis public/favicon.svg).
  icon: 'icon.png',
  server: {
    type: 'node',
    entry_point: 'server.js',
    mcp_config: { command: 'node', args: ['${__dirname}/server.js'], env: {} },
  },
  tools: tools.map(({ name, description }) => ({ name, description })),
  keywords: ['synthesizer', 'modular', 'music', 'audio', 'sound design'],
  license: pkg.license,
  compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=20.0.0' } },
};
writeFileSync(new URL('./manifest.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
