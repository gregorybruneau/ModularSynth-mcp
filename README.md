# modularsynth-mcp

Let your AI (Claude Desktop, Claude Code, or any MCP client) build and play patches in [ModularSynth](https://modularsynth.app/), the free modular synthesizer in your browser.

## Install

- **Claude Desktop**: download [modularsynth.mcpb](https://modularsynth.app/modularsynth.mcpb) then in Claude Desktop open Settings → Extensions → Advanced settings → “Install Extension…” and pick it (drag and drop doesn't always work on Windows).
- **Claude Code**: `claude mcp add modularsynth -- npx -y modularsynth-mcp@latest`
- **Any MCP client**:

  ```json
  { "mcpServers": { "modularsynth": { "command": "npx", "args": ["-y", "modularsynth-mcp@latest"] } } }
  ```

Then open https://modularsynth.app, click **AI** in the top bar and check **Connect this tab to the server**.

## How it works

The server speaks MCP over stdio to your AI, and listens on `ws://127.0.0.1:27900` for the ModularSynth tab (set `MODULARSYNTH_PORT` to change the port). Only the ModularSynth site may connect (a local development copy too, with `MODULARSYNTH_DEV=1`). Nothing leaves your computer. Every change the AI makes can be undone with Ctrl+Z in the tab.

Tools: `describe_patch`, `list_module_types`, `list_presets`, `load_preset`, `new_patch`, `add_module`, `remove_module`, `connect`, `disconnect`, `set_param`, `set_bypass`, `set_notes`, `set_steps`, `transform_notes`, `set_voices`, `play_notes`, `listen`, `look`, `what_changed`, `show_player`, `save_scene`, `recall_scene`, `set_song`, `play_song`, `highlight`, `list_sounds`, `set_sample`, `set_transport`, `undo`.

What makes it more than a remote control:

- **It sees and listens**: `look` returns images (rack photo, a module's panel, oscilloscope and spectrum), `listen` the output level and the silent modules.
- **It plays with you**: every answer ends with what the user changed since the AI's last action (`what_changed` on demand).
- **A player in the conversation**: `show_player` shows a small MCP Apps card (play/stop, level, rack photo, knobs) in clients that support MCP Apps, such as Claude Desktop.
- **Prompts** (ready-made requests: techno loop, ambient pad, explain this patch, jam with me…), **resources** (each module's documentation, the presets as complete example patches, the current patch) and server **instructions**.

## The player card (MCP Apps)

In apps that support MCP Apps (Claude Desktop, for example), the AI can put a small **ModularSynth player** right in the conversation with `show_player`, usually once it has finished a patch. Just ask: “show me the player”.

The card shows the patch name, a **▶ / ■** button for the clock, the current scene, the output level, a **photo of the rack** and up to **six knobs** the AI picked as the ones that matter most for this sound (or sensible defaults). Turn them and you hear the change at once; the photo follows the rack as you play.

The sound still comes from the ModularSynth tab, which must stay open and connected. Everything you do on the card is a normal move in the tab (Ctrl+Z undoes it), and the AI sees it like any other change. The card's own tools (`player_state`, `player_look`, `player_set`) are reserved for the card: other clients don't get them.

## Troubleshooting

If the AI panel stays on “waiting for the server…”:

1. **The server isn't running.** It starts with your AI app: in Claude Desktop, check that the extension is enabled; with Claude Code, that `modularsynth` is listed by `claude mcp list`. Restart the app after installing.
2. **The browser blocks the connection.** Chrome (and browsers built on it) asks for permission to reach devices on your local network the first time: allow it (or in the site settings, Local network access → Allow). Some privacy extensions block it too.
3. **Another port.** The page connects to port 27900: if you set `MODULARSYNTH_PORT`, remove it.
4. **Another tab is connected.** Only one ModularSynth tab talks to the server: close the other one, or uncheck it there.

---

## En français

Permet à ton IA (Claude Desktop, Claude Code ou tout client MCP) de construire et jouer des patches dans [ModularSynth](https://modularsynth.app/).

- **Claude Desktop** : télécharge [modularsynth.mcpb](https://modularsynth.app/modularsynth.mcpb) puis dans Claude Desktop : Réglages → Extensions → Paramètres avancés → « Installer une extension… » (le glisser-déposer ne marche pas toujours sous Windows).
- **Claude Code** : `claude mcp add modularsynth -- npx -y modularsynth-mcp@latest`

Ouvre ensuite https://modularsynth.app, clique sur **IA** dans la barre du haut et coche **Connecter cet onglet au serveur**. Rien ne quitte ta machine ; chaque geste de l'IA s'annule avec Ctrl+Z.

**La carte du lecteur (MCP Apps).** Dans les applications compatibles MCP Apps (Claude Desktop par exemple), l'IA peut afficher un petit **lecteur ModularSynth** dans la conversation (`show_player`), souvent quand elle a fini un patch : demande-lui « montre-moi le lecteur ». On y trouve le nom du patch, **▶ / ■**, la scène, le niveau de sortie, une **photo du rack** et jusqu'à **six potards** choisis pour ce son. Tourne-les : le son change aussitôt dans l'onglet ModularSynth, qui doit rester ouvert et connecté ; chaque geste s'annule avec Ctrl+Z et l'IA le voit.

## Development

- `npm install`, then `npm test`.
- To connect a local copy of the site (`http://localhost:…`), start the server with `MODULARSYNTH_DEV=1`: otherwise only https://modularsynth.app is accepted.
- `node build-manifest.js && npx @anthropic-ai/mcpb pack .` builds the Claude Desktop extension (`.mcpb`).
- The server only relays calls: the tools themselves run in the ModularSynth page. `tools.json` (names, descriptions, input schemas, annotations) is generated from the site's code and copied here at each release.

## Privacy

Nothing is collected or sent anywhere. The server talks to your AI app over stdio and to the ModularSynth tab over a WebSocket on `127.0.0.1` only; it accepts connections from the ModularSynth site only (and from a local development copy with `MODULARSYNTH_DEV=1`).

## License

MIT
