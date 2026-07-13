import type { MCPServer, MCPTool } from '@types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@main/apiServer/utils/mcp', () => ({
  getMCPServersFromRedux: vi.fn()
}))

vi.mock('@main/services/WindowService', () => ({
  windowService: {
    getMainWindow: vi.fn(() => null)
  }
}))

import { getMCPServersFromRedux } from '@main/apiServer/utils/mcp'
import mcpService from '@main/services/MCPService'

// Helper to get the server key used internally by MCPService
function getServerKey(server: MCPServer): string {
  return JSON.stringify({
    baseUrl: server.baseUrl,
    command: server.command,
    args: Array.isArray(server.args) ? server.args : [],
    registryUrl: server.registryUrl,
    env: server.env,
    id: server.id
  })
}

// Helper to create a mock Client with controllable ping
function createMockClient(pingResult: boolean) {
  return {
    ping: vi.fn().mockResolvedValue(pingResult),
    close: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    setNotificationHandler: vi.fn()
  }
}

const baseInputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] } = {
  type: 'object',
  properties: {},
  required: []
}

const createTool = (overrides: Partial<MCPTool>): MCPTool => ({
  id: `${overrides.serverId}__${overrides.name}`,
  name: overrides.name ?? 'tool',
  description: overrides.description,
  serverId: overrides.serverId ?? 'server',
  serverName: overrides.serverName ?? 'server',
  inputSchema: baseInputSchema,
  type: 'mcp',
  ...overrides
})

describe('MCPService.listAllActiveServerTools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('filters disabled tools per server', async () => {
    const servers: MCPServer[] = [
      {
        id: 'alpha',
        name: 'Alpha',
        isActive: true,
        disabledTools: ['disabled_tool']
      },
      {
        id: 'beta',
        name: 'Beta',
        isActive: true
      }
    ]

    vi.mocked(getMCPServersFromRedux).mockResolvedValue(servers)

    const listToolsSpy = vi.spyOn(mcpService as any, 'listToolsImpl').mockImplementation(async (server: any) => {
      if (server.id === 'alpha') {
        return [
          createTool({ name: 'enabled_tool', serverId: server.id, serverName: server.name }),
          createTool({ name: 'disabled_tool', serverId: server.id, serverName: server.name })
        ]
      }
      return [createTool({ name: 'beta_tool', serverId: server.id, serverName: server.name })]
    })

    const tools = await mcpService.listAllActiveServerTools()

    expect(listToolsSpy).toHaveBeenCalledTimes(2)
    expect(tools.map((tool) => tool.name)).toEqual(['enabled_tool', 'beta_tool'])
  })
})

describe('MCPService.initClient ping cache', () => {
  const server: MCPServer = {
    id: 'ping-test-server',
    name: 'Ping Test Server',
    baseUrl: 'http://localhost:3000',
    type: 'sse',
    isActive: true
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset internal state
    ;(mcpService as any).clients = new Map()
    ;(mcpService as any).pendingClients = new Map()
    ;(mcpService as any).pingCache = new Map()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns existing client on ping cache hit without calling ping', async () => {
    const mockClient = createMockClient(true)
    const serverKey = getServerKey(server)

    // Pre-populate the clients map with a mock client
    ;(mcpService as any).clients.set(serverKey, mockClient)

    // First call - should ping and cache result
    const result1 = await mcpService.initClient(server)
    expect(mockClient.ping).toHaveBeenCalledTimes(1)
    expect(result1).toBe(mockClient)

    // Second call - should use cache, ping NOT called again
    const result2 = await mcpService.initClient(server)
    expect(mockClient.ping).toHaveBeenCalledTimes(1) // still 1, not 2
    expect(result2).toBe(mockClient)
  })

  it('calls ping again after TTL expires', async () => {
    const mockClient = createMockClient(true)
    const serverKey = getServerKey(server)

    // Pre-populate
    ;(mcpService as any).clients.set(serverKey, mockClient)

    // Set a very short TTL for testing
    const originalTTL = (mcpService as any).PING_CACHE_TTL
    ;(mcpService as any).PING_CACHE_TTL = 50 // 50ms

    try {
      // First call - pings
      await mcpService.initClient(server)
      expect(mockClient.ping).toHaveBeenCalledTimes(1)

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 80))

      // Second call - TTL expired, should ping again
      await mcpService.initClient(server)
      expect(mockClient.ping).toHaveBeenCalledTimes(2)
    } finally {
      ;(mcpService as any).PING_CACHE_TTL = originalTTL
    }
  })

  it('deletes client and clears cache when ping fails', async () => {
    const mockClient = createMockClient(false)
    const serverKey = getServerKey(server)

    // Pre-populate
    ;(mcpService as any).clients.set(serverKey, mockClient)

    // Call initClient with a failing ping
    // This will fail ping, delete client, then try to create new one
    // Since we can't easily mock the full transport creation, we verify
    // that the client was deleted and pingCache was set correctly
    try {
      await mcpService.initClient(server)
    } catch {
      // Expected to throw since we can't create a real transport
    }

    // Verify client was removed
    expect((mcpService as any).clients.has(serverKey)).toBe(false)
    // Verify ping cache recorded the failure
    const cachedPing = (mcpService as any).pingCache.get(serverKey)
    expect(cachedPing).toBeDefined()
    expect(cachedPing.result).toBe(false)
  })

  it('clears ping cache on client close', async () => {
    const mockClient = createMockClient(true)
    const serverKey = getServerKey(server)

    // Pre-populate both clients and pingCache
    ;(mcpService as any).clients.set(serverKey, mockClient)
    ;(mcpService as any).pingCache.set(serverKey, { result: true, timestamp: Date.now() })

    // Close the client
    await mcpService.closeClient(serverKey)

    // Verify both client and pingCache were cleared
    expect((mcpService as any).clients.has(serverKey)).toBe(false)
    expect((mcpService as any).pingCache.has(serverKey)).toBe(false)
  })
})

describe('MCPService.initClient ping cache performance', () => {
  const server: MCPServer = {
    id: 'perf-test-server',
    name: 'Perf Test Server',
    baseUrl: 'http://localhost:4000',
    type: 'sse',
    isActive: true
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ;(mcpService as any).clients = new Map()
    ;(mcpService as any).pendingClients = new Map()
    ;(mcpService as any).pingCache = new Map()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls ping only 1 time for 10 consecutive initClient calls (cache hit)', async () => {
    const mockClient = createMockClient(true)
    const serverKey = getServerKey(server)

    // Pre-populate
    ;(mcpService as any).clients.set(serverKey, mockClient)

    // Call initClient 10 times rapidly
    for (let i = 0; i < 10; i++) {
      const result = await mcpService.initClient(server)
      expect(result).toBe(mockClient)
    }

    // Ping should only be called once (first call caches, subsequent 9 use cache)
    expect(mockClient.ping).toHaveBeenCalledTimes(1)
  })
})
