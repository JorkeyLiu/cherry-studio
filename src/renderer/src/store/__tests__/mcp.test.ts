import { BuiltinMCPServerNames } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { builtinMCPServers } from '../mcp'

describe('MCP filesystem defaults', () => {
  it('disables auto-approve for sensitive filesystem tools by default', () => {
    const filesystemServer = builtinMCPServers.find((server) => server.name === BuiltinMCPServerNames.filesystem)

    expect(filesystemServer?.disabledAutoApproveTools).toEqual(['write', 'edit', 'delete'])
  })
})
