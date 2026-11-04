# Permission profiles (local prototype)

The composer has **Profile** and **Without a rule** selectors, plus **Rules…** to
open the project's remembered decisions. The agent is fixed
when the session is initialized. The **Agent for new sessions** card is pinned to
the bottom of the **Sessions** view itself. The list above it scrolls independently;
moving Sessions to another sidebar also moves the selector. There is no second
view to enable or arrange. The list retains folders, nested subagents, keyboard
navigation, context actions and drag-and-drop. Agent display names are consistent
with the chat. Model selection remains independent.

## Configuration layers

These are extension settings, not OpenCode's native `permissions` array:

1. Built-in profiles (`read-only`, `workspace`, `host`, `all`).
2. `opencodeSessions.permissionProfiles` — User, application scope.
3. `opencodeSessions.hostPermissionProfiles` — Host, machine scope; use Remote
   settings in an SSH / container window.
4. `opencodeSessions.workspacePermissionProfiles` — Workspace settings.
5. The same Workspace key in a workspace folder's settings (multi-root).

VS Code's public configuration inspection API combines local and remote user
values. Separate User and Host keys are intentional: ordinary VS Code object
merging must not erase an earlier restriction. Workspace values placed under the
User or Host key are ignored. Global values under the Workspace key are ignored.

Within a layer, the **last matching rule** wins. Across layers, the strictest
matching decision wins: **deny > ask > allow**. A layer with no matching rule
abstains. Remembered project decisions can answer an ask, but never override a
matching profile deny. Only when both profiles and remembered rules abstain does
**Without a rule** apply:
`forbid → deny`, `ask → ask`, `smart → classifier review`, `permit → allow`.

## Smart review

Choose **Smart** under Without a rule to use the **permission-classifier** agent.
Only unmatched actions are reviewed. Explicit asks and denies from profile layers
still win, including across inherited parent profiles. Smart never automatically
turns a configured profile-layer ask into an allow.

The extension creates `<OpenCode config>/agents/permission-classifier.md` once,
from the bundled template. Existing agent files are never overwritten. You can
edit its instructions offline and optionally set a `model` in its frontmatter.
Without an agent model, review uses the session model, then the server default.
The stateless generation API uses this agent's instructions and model, not its
other generation tuning fields. It has no tools and creates no child session.

The classifier receives the complete proposed action/resources and available tool
arguments, plus up to four recent user text messages and four size-bounded tool
records (for example, previously read script contents). Omitted optional tool
records are explicitly marked as omitted. It returns JSON with
`decision: allow | deny` and `reason`. Oversized evidence, missing instructions,
invalid output, provider failure, and timeout all block the operation. The timeout
defaults to 30 seconds (`opencodeSessions.smartTimeoutSeconds`, 5–120). An allow
is discarded if the permission snapshot changes while review is running.

Reviewing/Allowed/Blocked cards appear in the chat, including the reason and model
in a tooltip. Recent reviews are held in server memory, not written to transcript
or disk; plugin reload clears them. The generation API does not return usage, so
classifier token usage is not included in the session footer. Smart adds a model
call, not an OS sandbox or a change to the main agent's prompt.

Example User / Host settings (choose the corresponding key):

```jsonc
{
  "opencodeSessions.hostPermissionProfiles": {
    "read-only": {
      "rules": [
        { "action": "read", "resource": "*.env", "effect": "deny" }
      ]
    },
    "workspace": {
      "rules": [
        { "action": "shell", "resource": "git push *", "effect": "deny" }
      ]
    }
  }
}
```

Example `.vscode/settings.json`:

```jsonc
{
  "opencodeSessions.workspacePermissionProfiles": {
    "read-only": {
      "rules": [
        { "action": "read", "resource": "private/*", "effect": "deny" }
      ]
    },
    "workspace": {
      "rules": [
        { "action": "shell", "resource": "git status *", "effect": "allow" }
      ]
    }
  },
  "opencodeSessions.defaultPermissionProfile": "workspace",
  "opencodeSessions.agentPermissionProfiles": {
    "plan": "read-only",
    "security-reviewer": "read-only"
  }
}
```

Adding `allow *` in Workspace cannot undo the built-in read-only deny or a Host
deny. A Host-layer `ask` cannot be bypassed with a Workspace-layer `allow` either;
the user can answer it with an explicit remembered project decision.
To tighten a profile everywhere, put restrictions on that profile in User / Host.
These are profile restrictions, not an organizational ban on selecting another
profile or editing your own settings.

## Profiles and matching

- **Read only:** allowlisted read/search/web/skill/question operations and
  subagents with inherited restrictions. All other actions (including shell,
  Code Mode and unclassified MCP tools) are denied. Without a rule is disabled.
- **Workspace:** reading and edits inside the session directory are allowed;
  external edits ask. Unmatched operations (shell, Code Mode, MCP, etc.) use Without a rule.
- **Host:** currently the same access as All, but a separate profile with its own
  remembered rules. Refers to the machine executing OpenCode (the remote machine
  in Remote SSH). No network or host-boundary isolation is implemented yet.
- **All:** explicit allow for all actions, still narrowed by other layers and
  server restrictions. Without a rule is disabled.
- Add a new profile ID in User settings to create a custom profile. Its optional
  `label` and `newActions` provide display text and an initial fallback.

Rules use `{action, resource, effect, match?}`; actions/resources support `*` and `?`
whole-value wildcards. `*` crosses directory separators. File resources are relative
to the session directory, or absolute. `${workspace}` expands to that directory.
File checks resolve symlinks, including existing ancestors of new files. Shell
resources come from OpenCode's command scanner; this is not a command sandbox.
`match: "exact"` matches a literal resource, so `echo *` does not authorize `echo secret`.
Omitted `match` means `glob`, preserving existing profiles.

**Read restrictions:** grep permissions normally check a regex, not every visited
file. This prototype conservatively blocks grep/glob/shell/execute whenever a
custom layer restricts reading. Use direct reads instead. Arbitrary external tools
and MCP implementations remain responsible for declaring their operations; this
is permission enforcement, not OS-level isolation against untrusted tool code.

## Session behavior

The selected profile and each profile's Without a rule choice are persisted server-side
per session. Switching back restores its choice; a new session uses defaults.
Agent-to-profile assignments initialize new managed sessions, not existing ones.
Settings are reapplied when a session opens, when you change a selector, or before
the next turn. Selectors can be changed only between turns.

Approval cards show the effective rule/reason, file paths, available diffs and
command arguments. **Allow once / Reject** answer only that request. **Save rule…**
offers Allow/Forbid for exact files, containing directories with their contents, or
exact requested commands/resources. Targets come from the server's pending permission,
not inferred from a display title. A directory selection covers each displayed directory
and its entire subtree. An opaque operation with resource `*` cannot be remembered as
an exact command; use the profile fallback or explicit offline rules instead.

Saved rules always apply to **all managed sessions in this project using that profile**.
There is no session/project scope picker. They live in `.opencode/permission-rules.json`:

```json
{
  "version": 1,
  "profiles": {
    "workspace": {
      "rules": [
        { "action": "edit", "resource": "${workspace}/docs/*", "effect": "allow", "match": "glob" },
        { "action": "shell", "resource": "git status", "effect": "allow", "match": "exact" }
      ]
    }
  }
}
```

**Rules…** or **OpenCode: Open Permission Rules (JSON)** opens this file with JSON
validation. Edit/remove rules to change/revoke them. The server rereads it on every
operation; other sessions need no reload. Within a profile the last matching saved
rule wins; profile denies and inherited ancestor restrictions remain effective.
Deleting the file removes remembered decisions. Malformed JSON blocks managed
operations with an error instead of dropping restrictions. Saving while rules change
rejects the outdated choice and refreshes the card; it never grants a stale approval.
All target files in a multi-file request must be covered before a saved Allow answers
the pending request. Native configured denies and server policies still apply.

Children are checked against their agent's assigned profile, when configured, and
every managed ancestor's profile. A child opened in its own tab displays inherited
permissions and cannot relax them. Native child-agent permissions also apply.

## Server plugin

The extension installs its bundled V2 plugin at
`<OpenCode config>/plugins/vscode-permission-profiles/` when opening a chat.
It confirms the plugin's RPC is available before allowing a prompt. Rules are
enforced by `permission/evaluate` plus an execution hook for Code Mode and opaque
tools, without changing the agent, native session
permissions, tool definitions or system prompt. Only explicitly configured sessions
and their descendants are affected. Other sessions are left to OpenCode's rules.

Session policy snapshots are in that plugin's `state/` directory. They continue to
apply when a managed session is used from another client. No credentials are stored.
Changes to the settings need this extension to refresh the snapshot.

OpenCode 2.2.5 starts a private server for each ACP process. Pending permissions are
in-memory objects owned by that process, not by the shared service. RPC v4 routes
**describe / remember** to that owner over local IPC (a private Unix socket on Linux,
a named pipe on Windows). Discovery files under `state/owners/` contain only an owner
ID and socket path; no server passwords or permission payloads. The owner rechecks
the real pending request and current policy before saving. Disconnected or resolved
requests return a readable error rather than an HTTP 500 or a guessed approval.

`test/permission-live.js` is opt-in: with `OPENCODE_PERMISSION_LIVE=1`, it installs
the bundle, starts a standalone server, creates one temporary session, and verifies
shared-service RPC routing and native Allow/Forbid enforcement. It performs no model
generation or tool execution, then deletes the session and its fixtures.

Use **Developer: Reload Window** to load the locally modified extension. Open a new
chat, select a profile and ask it to read or change a scratch file. If the plugin
cannot load, the chat reports an error rather than claiming a profile is active.
