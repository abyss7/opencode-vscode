# VS Code archive integration

This managed OpenCode plugin registers `/archive`. The command waits for the
session to become idle, calls the optional `vscode-archive-hook.beforeArchive`
RPC hook, and archives the session even when the hook fails.

A sibling global plugin can implement the hook, for example:

```ts
import { Plugin } from '@opencode/plugin'
import { ArchiveHook } from '../vscode-archive/hook.js'

export default Plugin.define({
  id: 'local-archive-hook',
  async setup(ctx) {
    return ctx.rpc.register(ArchiveHook, {
      async beforeArchive({ sessionID, delivery }) {
        await ctx.session.prompt({ sessionID, text: '@handoff', delivery })
        await ctx.session.wait({ sessionID })
        return {}
      },
    })
  },
})
```
