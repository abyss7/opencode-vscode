import { Plugin } from '@opencode/plugin'
import { Rpc } from '@opencode/plugin/rpc'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
for (const file of ['./runtime.cjs', './engine.cjs', './classifier.cjs', './project.cjs', './bridge.cjs', './global.cjs', './jsonc.js', './session-temp.cjs']) delete require.cache[require.resolve(file)]
const { setup } = require('./runtime.cjs')
const contract = Rpc.define({
  id: 'vscode-permission-profiles',
  events: {},
  methods: {
    status: {
      errors: {},
      input: { type: 'object', additionalProperties: false },
      output: { type: 'object', additionalProperties: true },
    },
    configure: {
      errors: {},
      input: { type: 'object', additionalProperties: true },
      output: { type: 'object', additionalProperties: true },
    },
    reviews: {
      errors: {},
      input: { type: 'object', properties: { sessionID: { type: 'string' } }, required: ['sessionID'], additionalProperties: false },
      output: { type: 'object', additionalProperties: true },
    },
    describe: {
      errors: {},
      input: { type: 'object', additionalProperties: true },
      output: { type: 'object', additionalProperties: true },
    },
    remember: {
      errors: {},
      input: { type: 'object', additionalProperties: true },
      output: { type: 'object', additionalProperties: true },
    },
  },
})

export default Plugin.define({
  id: 'vscode-permission-profiles',
  async setup(ctx) {
    return setup(ctx, contract, new URL('./state/', import.meta.url))
  },
})
