# modularsynth-mcp

Let your AI (Claude Desktop, Claude Code, or any MCP client) build and play patches in [ModularSynth](https://modularsynth.app/), the free modular synthesizer in your browser.

## Install

- **Claude Desktop**: download [modularsynth.mcpb](https://modularsynth.app/modularsynth.mcpb) then in Claude Desktop open Settings → Extensions → Advanced settings → “Install Extension…” and pick it (drag and drop doesn't always work on Windows).
- **Claude Code**: `claude mcp add modularsynth -- npx -y modularsynth-mcp`
- **Any MCP client**:

  ```json
  { "mcpServers": { "modularsynth": { "command": "npx", "args": ["-y", "modularsynth-mcp"] } } }
  ```

Then open https://modularsynth.app, click **AI** in the top bar and check **Connect this tab to the server**.

## How it works

The server speaks MCP over stdio to your AI, and listens on `ws://127.0.0.1:27900` for the ModularSynth tab (set `MODULARSYNTH_PORT` to change the port). Only the ModularSynth site (and local development) may connect. Nothing leaves your computer. Every change the AI makes can be undone with Ctrl+Z in the tab.

Tools: `describe_patch`, `list_module_types`, `list_presets`, `load_preset`, `new_patch`, `add_module`, `remove_module`, `connect`, `disconnect`, `set_param`, `set_bypass`, `set_notes`, `play_notes`, `save_scene`, `recall_scene`, `set_song`, `play_song`, `highlight`, `set_transport`, `undo`.

---

## En français

Permet à ton IA (Claude Desktop, Claude Code ou tout client MCP) de construire et jouer des patches dans [ModularSynth](https://modularsynth.app/).

- **Claude Desktop** : télécharge [modularsynth.mcpb](https://modularsynth.app/modularsynth.mcpb) puis dans Claude Desktop : Réglages → Extensions → Paramètres avancés → « Installer une extension… » (le glisser-déposer ne marche pas toujours sous Windows).
- **Claude Code** : `claude mcp add modularsynth -- npx -y modularsynth-mcp`

Ouvre ensuite https://modularsynth.app, clique sur **IA** dans la barre du haut et coche **Connecter cet onglet au serveur**. Rien ne quitte ta machine ; chaque geste de l'IA s'annule avec Ctrl+Z.

## Development

- `npm install`, then `npm test`.
- `node build-manifest.js && npx @anthropic-ai/mcpb pack .` builds the Claude Desktop extension (`.mcpb`).
- The server only relays calls: the tools themselves run in the ModularSynth page. `tools.json` (names, descriptions, input schemas, annotations) is generated from the site's code and copied here at each release.

## Privacy

Nothing is collected or sent anywhere. The server talks to your AI app over stdio and to the ModularSynth tab over a WebSocket on `127.0.0.1` only; it accepts connections from the ModularSynth site (and local development) only.

## License

MIT
