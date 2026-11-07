import { Plugin } from '@opencode/plugin'
import { Rpc } from '@opencode/plugin/rpc'
import { createRequire } from 'node:module'
import { ArchiveHook } from './hook.js'

const require = createRequire(import.meta.url)
delete require.cache[require.resolve('./runtime.cjs')]
const { setup } = require('./runtime.cjs')

const Finalization = {
  type: 'object',
  properties: {
    archivedAt: { type: 'number' },
    state: { type: 'string', enum: ['pending', 'succeeded', 'failed'] },
    error: { type: 'string' },
  },
  required: ['archivedAt', 'state'],
  additionalProperties: false,
} as const

const Archive = Rpc.define({
  id: 'vscode-archive',
  methods: {
    status: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' } },
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          version: { type: 'number' },
          finalization: Finalization,
        },
        required: ['version'],
        additionalProperties: false,
      },
      errors: {},
    },
    afterArchive: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' } },
        required: ['sessionID'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { finalization: Finalization },
        required: ['finalization'],
        additionalProperties: false,
      },
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
