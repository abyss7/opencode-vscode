import { Rpc } from '@opencode/plugin/rpc'

export const ArchiveHook = Rpc.define({
  id: 'vscode-archive-hook',
  methods: {
    beforeArchive: {
      input: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          delivery: { type: 'string', enum: ['queue'] },
        },
        required: ['sessionID', 'delivery'],
        additionalProperties: false,
      },
      output: { type: 'object', additionalProperties: false },
      errors: {},
    },
  },
  events: {},
})
