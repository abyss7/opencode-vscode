# VS Code archive integration

This managed OpenCode plugin registers `/archive`. The session is archived
first, then the optional `vscode-archive-hook.afterArchive` RPC hook runs as a
tracked background finalization. After a successful hook, an available
`/cleanup` command runs and the finalization waits for it. Cleanup is skipped
when the hook is absent, fails, or the session was restored or re-archived.
Hook or cleanup failure never restores the session.

A sibling global plugin can implement the hook, for example:

```ts
import { Plugin } from '@opencode/plugin'
import { ArchiveHook } from '../vscode-archive/hook.js'

export default Plugin.define({
  id: 'local-archive-hook',
  async setup(ctx) {
    const registration = await ctx.rpc.register(ArchiveHook, {
      async afterArchive({ sessionID, delivery }) {
        await ctx.session.prompt({ sessionID, text: '@handoff', delivery })
        await ctx.session.wait({ sessionID })
        return {}
      },
    })
    return () => registration.dispose()
  },
})
```
