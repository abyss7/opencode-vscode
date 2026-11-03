# OpenCode for VS Code

A local extension that lists OpenCode sessions in the sidebar and opens each session in its own
editor tab as an ACP chat.

## Features

- A dedicated OpenCode icon in the Activity Bar and a session list scoped to the current workspace.
- Sessions are grouped into folders: new sessions start in **Ungrouped**, custom folders can be
  created and deleted, and the system **Archived** folder holds archived sessions.
- Sub-agent sessions (child sessions spawned by an agent) are shown nested under their parent
  session with a distinct icon; they can be opened and deleted like any session.
- Drag a session onto a folder, or use **Move to Folder…** in the context menu.
- Rename a session from the context menu; the open tab title follows the new name.
- Archive a session with the archive icon next to the trash icon and restore it from Archived.
- Create, delete, and open sessions.
- Each session opens in its own tab; opening it again reveals the existing tab.
- Chat runs over the Agent Client Protocol: the extension spawns a separate `opencode acp`
  process for every tab.
- Session history is restored with `session/load` (text, reasoning, tool calls).
- Streaming responses, compact Claude-style message and tool blocks with IN/OUT sections.
- All intermediate output between your question and the final answer is folded under one summary.
- A live line under that summary shows the current action, its approximate token use, and how
  long the turn has been running (for example `working for 1m 37s`).
- While a shell command runs, a short prefix of the command is shown; otherwise the line falls back to `working`.
- Model output is buffered and rendered only once the message is complete, so the text never
  flickers from raw chunks into formatted markdown.
- Paste images from the clipboard directly into the composer; they are sent as ACP image blocks.
- Type `/` in the composer to autocomplete slash commands and skills.
- File references in answers (`src/api.js:42`, markdown links to files, and tool-call locations)
  open in an editor tab beside the chat at that line and column. A reference becomes a link only
  after the extension confirms that the file exists; everything else stays plain text.
- Answers support nested Markdown lists, task lists, footnotes and GitHub-style callouts.
- Code blocks have syntax highlighting and a copy button.
- Fenced `mermaid` blocks render as diagrams with zoom, fit and source controls.
- LaTeX formulas render with KaTeX: `$...$`, `$$...$$`, `\(...\)` and `\[...\]`.
  Display formulas expose their LaTeX source. Rendering libraries and fonts work offline.
- The extension automatically appends a short description of its presentation formats to
  regular and queued prompts, including image prompts. You do not need to repeat it.
  This context is stored with the prompt but omitted from the extension's transcript view.
- Opening or revealing a session tab scrolls to the newest message and focuses the composer.
- The tab icon is orange while the session works and green when an answer is waiting; it returns
  to the default icon as soon as you open the tab.
- Token estimates are shown for every intermediate operation and for the whole turn.
- A collapsible **Sub-agents** strip at the top of the chat shows how many sub-agents are
  running, what each one is currently doing, and an estimated token count per sub-agent.
  Click an entry to open that sub-agent in its own tab; the strip opens automatically while
  sub-agents run.
- Sub-agent tool calls in the transcript are folded into one compact entry instead of dumping
  their full prompt and output, so the conversation stays tidy.
- Turn counters are rebuilt from the server message history after a turn ends and after a
  reload, so a restored turn keeps the same step and token estimates.
- The composer shows context usage, cost, remaining budget, and reset time when available.
- Consecutive tool calls and reasoning chunks are grouped under a single collapsible header.
- Reasoning, plans, and tool details are collapsed by default; permission prompts stay visible.
- Model and mode switching (build/plan) via `session/set_config_option`.
- Tabs are restored when the VS Code window reloads.
- Every supported OpenCode setting is available in the native VS Code Settings editor and is
  kept in sync with `opencode.json(c)` at the matching scope.

## Requirements

- VS Code 1.85+.
- OpenCode v2 available in `PATH` (tested with `opencode 2.2.3`).
- A running OpenCode background server (`opencode service start`). The extension starts it
  automatically on the first session list request.

## Installation

```bash
cd /path/to/opencode-vscode
./install.sh
```

The script creates a symlink to the extension in the VS Code extensions directory:

- Remote/SSH: `~/.vscode-server/extensions/abyss7.opencode-sessions-<version>`
- Local VS Code: `~/.vscode/extensions/abyss7.opencode-sessions-<version>`

After installation, run **Developer: Reload Window**.

If the extensions directory is in a non-standard location, set it explicitly:

```bash
VSCODE_EXTENSIONS_DIR=/path/to/extensions ./install.sh
```

The symlink installation is meant for development: it runs the sources straight from
the repository.

### Install from a release

Download `opencode-sessions-<version>.vsix` from the
[Releases](https://github.com/abyss7/opencode-vscode/releases) page, then either:

- VS Code: **Extensions** view → `...` menu → **Install from VSIX…**;
- CLI: `code --install-extension opencode-sessions-<version>.vsix`.

Releases are built from `v<version>` tags by `.github/workflows/release.yml`, which
runs the checks and attaches the packaged VSIX. To build one locally:

```bash
node scripts/package.js
```

The script packages a staging copy with the runtime model and agent lists removed, so
the release never carries the author's provider catalogue.

## Settings

OpenCode settings use the normal VS Code Settings editor. Open **Settings**, search for
`@ext:abyss7.opencode-sessions`, or run **OpenCode: Open Settings** / click the gear icon in the
Sessions view.

### Extension settings

| Setting | Default | Description |
| --- | --- | --- |
| `opencodeSessions.command` | `opencode` | Command used to launch OpenCode. Set a full path if the binary is not in `PATH`. |
| `opencodeSessions.autoApprovePermissions` | `ask` | `ask` prompts in chat; `allowAll` allows every agent request. |

The old `opencode.command` and `opencode.autoApprovePermissions` keys are still read as a fallback.

### OpenCode settings

The extension contributes only the OpenCode settings that change what happens inside a session:
the model and agent that answer, their tools, permissions, MCP servers, skills, commands,
instructions and references, how image attachments, tool output and context compaction are
handled, and the shell, formatter and language servers the agent runs. Everything else
(`update`, `share`, `enterprise`, `username`, `timezone`, `snapshots`, `warming`, `worktree`,
`experimental.*`) only affects the OpenCode client and is left to `opencode.json(c)`, where the
bundled schema still validates and completes it. The allowlist lives in `KEEP_PATHS` in
`scripts/generate-configuration.js`.

These settings have the standard VS Code scopes:

| VS Code scope | OpenCode file |
| --- | --- |
| User (local window) | `~/.config/opencode/opencode.json(c)` (or `$XDG_CONFIG_HOME/opencode`) |
| Remote [SSH: host] | `~/.config/opencode/opencode.json(c)` on that host |
| Workspace | `<workspace>/opencode.json(c)` or `<workspace>/.opencode/opencode.json(c)` |
| Workspace Folder (multi-root) | `opencode.json(c)` in that folder |

In a Remote-SSH window the global OpenCode file is synchronized with the **Remote [SSH: host]**
scope, because that is the machine where OpenCode runs. Use the Remote tab for global values on
that host; the User tab is shared between hosts and is not mirrored into a host-specific
`opencode.json(c)`.

The existing OpenCode files are the source of truth:

- On startup their values are mirrored into the corresponding VS Code settings, so the Settings
  editor shows the real configuration.
- Changes in the Settings editor are written back into `opencode.json(c)` while preserving JSONC
  comments, `$schema`, key order, and unrelated settings.
- External edits to `opencode.json(c)` are picked up by a watcher and reflected in the Settings
  editor.
- If both sides changed at the same time, `opencode.json(c)` wins.
- OpenCode watches its configuration files, so a save is applied without restarting the service.

Structured values that VS Code cannot render (`agents`, `commands`, `providers`, `mcp.servers`,
`permissions`, `policies`, `plugins`, `formatter`/`lsp` overrides, `websearch`) are contributed,
but VS Code shows **Edit in settings.json** for them. That is a limitation of the native
Settings editor, not of the extension.

### Choosing the default model and agent

Both settings are dropdowns in the native Settings editor:

- `opencode.model` lists every installed model as `provider/model`, followed by one entry per
  declared variant (`provider/model#variant`, for example `acme/chat-large#high`). The
  description under each entry shows the model name, context size and price.
- `opencode.default_agent` lists the visible primary agents from `GET /api/agent`.

The lists cannot be queried by the Settings editor on demand: `contributes.configuration`, and
therefore `enum`, is read once when the extension host starts. The extension fills both lists at
startup (`src/setting-enums.js`) from the running service and writes them into its own
`package.json`. After adding a model, an agent or a provider, run **Developer: Reload Window**
to refresh the dropdowns — each setting's description says the same. A window opened while the
service is not running keeps the previous lists.

Values stay compact strings, so the settings sync writes them into `opencode.json(c)` unchanged.
If a file already stores the structured `{ providerID, model, variant }` form, the sync converts
it to `provider/model#variant` before mirroring it into the Settings editor.

`opencode.json` and `opencode.jsonc` files are associated with the bundled OpenCode schema, so
the JSON editor provides validation and autocomplete for structured fields too.

### Refreshing the schema

The settings contribution is generated from `src/schema/config.schema.json`, which is a copy of
`https://opencode.ai/config.json`. The generator emits only the paths listed in `KEEP_PATHS`. To
update it:

```bash
curl -sSL -o src/schema/config.schema.json https://opencode.ai/config.json
node scripts/generate-configuration.js
```

## How it works

- The session list comes from the OpenCode background server REST API (`/api/session`), filtered
  by the current workspace directory. Archived sessions come from the same endpoint with
  `archived=true`.
- Sub-agent sessions are fetched from the same endpoint without the top-level `parentID` filter;
  in the tree they are grouped under their parent session, and in the chat they are polled for a
  live summary (running count, current action, and an estimated token total).
- Folder names and session assignments are stored in the extension's global state, keyed by the
  workspace directory.
- Archiving and restoring use `PATCH /api/session/{id}` with `{ "archived": true|false }`.
- Renaming uses `PATCH /api/session/{id}` with `{ "title": "..." }`.
- File links are rendered as plain candidates first; the webview asks the extension
  (`checkFiles`) which paths exist and only those get link styling. Clicking a link sends
  `openFile`, resolved against the session directory and opened with
  `vscode.window.showTextDocument(..., { viewColumn: ViewColumn.Beside })`.
- Deletion uses `DELETE /api/session/{id}`.
- A new session is created over ACP (`session/new`) in the workspace directory.
- The chat tab is a webview connected to a dedicated `opencode acp` process over JSON-RPC/stdio.
- Answers are always printed outside the collapsible step block: an answer closes the current
  *steps* chevron, and the next thought or tool call opens a new one below the text. A turn that
  ends without any text gets one explanatory line (how many steps are collapsed, or the stop
  reason) instead of leaving a blank transcript under a *Ready* status.
- The tab title is updated after OpenCode generates a session title.

## Usage display

- Context usage, cost, and the context window size come from the ACP `usage_update` event.
- The token line shows `tokens: used (P% cached X ago) · compaction at N (M limit)`. `P` is the
  share of the last prompt that came from the provider cache, measured on the newest assistant
  message and floored to three decimals so a nearly full cache never reads as 100%; `X` says
  when that prompt was measured. The compaction threshold is the
  provider-declared input window (`limit.input`, falling back to `limit.context`) minus
  `compaction.buffer`, read from `GET /api/config`; `M` is the same window. Without a configured
  buffer the server default applies: 15% of the window, or 16k when the window is 32k or larger.
  If automatic compaction is disabled, the threshold is omitted.
- On open, the context is restored from the last assistant message
  (`/api/session/{id}/message`), the context limit from `GET /api/model`, and the accumulated
  session cost from `GET /api/session/{id}`. These values are exact as stored by the server.
- At the end of a turn the ACP result carries exact usage for the whole turn
  (`input`, `output`, `reasoning`, cache read/write). It replaces the estimate in the turn
  summary; the tooltip shows the breakdown. The turn header prints the uncached part first and
  the cached additions in parentheses: `12.5k tok (+140k cache read · +3.2k cache write)`, with
  zero terms dropped.
- Restored turns use the stored per-message counters the same way, so their headers are exact
  too: the billed sum is the turn total and the cache split is read back from the same records.
- ACP reports token usage per assistant step, not per individual tool call, so operation-level
  numbers are still estimates (`~N tok`). They are rebuilt from
  `GET /api/session/{id}/message` when a turn ends and when a session is restored, using the
  four-characters-per-token heuristic.
- The total cost includes direct sub-agent sessions; their share is shown in parentheses.
  Sub-agent token counts come from their session records when available. The cost tooltip
  splits the session spend by tariff (`input`, `output incl. reasoning`, `cache read`,
  `cache write`): every step is accounted with its own stored cost, so peak-hour rates and
  model switches are preserved, and the shares add up to the stored session total (steps the
  API no longer lists are covered by scaling the collected shares up to it).
- Console budget and reset information comes from `/api/experimental/usage/limits`; the
  remaining amount is matched to the selected model. When the server has no signed-in Console
  workspace, no budget line is shown.
- For DeepSeek models the account balance is read from `GET https://api.deepseek.com/user/balance`
  with the credential stored by OpenCode (`opencode auth export deepseek`) and shown after the
  cost. Other providers need their own balance source.
- Pasting images is enabled when the agent advertises the ACP `promptCapabilities.image`
  capability. The selected model must also accept image input.

## Commands and skills

- Typing `/` at the start of the composer opens an autocomplete list of slash commands and skills.
- Commands come from the ACP `available_commands_update` event and from `GET /api/command`.
- Skills come from `GET /api/skill` scoped to the workspace directory; they are inserted as
  `@skill-id` mentions, which OpenCode resolves into a skill load.
- Selecting an entry inserts `/name ` or `@skill-id `; arrow keys move the selection, `Enter` or
  `Tab` accepts it, `Esc` closes the list.
- Slash commands are executed by the background server (`POST /api/session/{id}/command`); `/compact`
  uses `POST /api/session/{id}/compact`. ACP only advertises commands, it cannot run them.
- After a command finishes, the transcript is reloaded with `session/load`; the expanded command
  template is replaced by the text you typed.

## Diagnostics

- The **OpenCode: Show Log** command (`opencode.showLog`) opens the `OpenCode` output
  channel with ACP/REST logs.
- If the list is empty or shows an error, check:

```bash
opencode service status
opencode service start
opencode auth login
```

- If the OpenCode command is not found, set the path in the `opencodeSessions.command` setting,
  for example `/home/user/.opencode/bin/opencode`.
- The output channel logs settings sync decisions, including the selected global and project
  files (`Settings sync: ...`). Check it if the Settings editor and `opencode.json` disagree.
- OpenCode reloads configuration files automatically. If a change is not picked up, run
  `opencode reload` or `opencode service restart`.

## Structure

```
src/extension.js          activation, commands, tabs, serialization
src/api.js                REST client for the OpenCode background server
src/acp.js                ACP client (JSON-RPC over stdio)
src/session-panel.js      webview session tab
src/sessions-view.js      session tree grouped by folders
src/session-folders.js    folder names and session assignments in global state
src/file-links.js         parsing of `path:line` references from chat
src/opencode-config.js    config directory discovery and file selection
src/opencode-sync.js      VS Code settings <-> opencode.json(c) synchronization
src/setting-enums.js      model/agent dropdown lists written into package.json at startup
src/jsonc.js              JSONC-preserving reads and writes
src/schema/               bundled OpenCode configuration schema
src/generated/            generated setting metadata
scripts/                  configuration generator
media/                    chat HTML/CSS/JS and icons
test/                     ACP/REST, JSONC, discovery, and sync tests
```

## Checks

```bash
npm run check   # syntax check of every source file
npm test        # unit tests, no OpenCode server needed
```

These unit tests also run in CI (`.github/workflows/checks.yml`). Integration checks
require `opencode` in `PATH` with a running service:

```bash
node test/smoke.js
node test/config.js
node test/panel.js
node test/extension.js
node test/child-updates.js
```

They use a temporary directory as the working folder; set `OPENCODE_TEST_CWD` to point
them somewhere else.

`test/slash.js` runs the webview script against a small fake DOM, so it needs no OpenCode server.

The settings sync is disabled in `test/extension.js` through
`OPENCODE_DISABLE_SETTINGS_SYNC=1` so tests never touch the real user configuration.

## License

MIT, see [LICENSE](LICENSE).
