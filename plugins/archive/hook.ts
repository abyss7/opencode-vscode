import { Rpc } from '@opencode/plugin/rpc'

export const ArchiveHook = Rpc.define({
  id: 'vscode-archive-hook',
  methods: {
    afterArchive: {
      input: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          archivedAt: { type: 'number' },
          delivery: { type: 'string', enum: ['queue'] },
        },
        required: ['sessionID', 'archivedAt', 'delivery'],
        additionalProperties: false,
      },
      output: { type: 'object', additionalProperties: false },
      errors: {},
    },
  },
  events: {},
})
