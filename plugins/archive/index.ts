import { Plugin } from '@opencode/plugin'
import { Rpc } from '@opencode/plugin/rpc'
import { createRequire } from 'node:module'
import { ArchiveHook } from './hook.js'

const require = createRequire(import.meta.url)
delete require.cache[require.resolve('./runtime.cjs')]
const { setup } = require('./runtime.cjs')

const Archive = Rpc.define({
  id: 'vscode-archive',
  methods: {
    status: {
      input: { type: 'object', additionalProperties: false },
      output: {
        type: 'object',
        properties: { version: { type: 'number' } },
        required: ['version'],
        additionalProperties: false,
      },
      errors: {},
    },
    archive: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' } },
        required: ['sessionID'],
        additionalProperties: false,
      },
      output: { type: 'object', additionalProperties: false },
      errors: {},
    },
  },
  events: {},
})

export default Plugin.define({
  id: 'vscode-archive',
  async setup(ctx) {
    return setup(ctx, ArchiveHook, Archive)
  },
})
