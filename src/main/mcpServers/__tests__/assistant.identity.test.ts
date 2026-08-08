import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn()
    })
  }
}))

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.0.0'),
    getName: vi.fn(() => 'Cherry Chat'),
    getLocale: vi.fn(() => 'en-US'),
    getPath: vi.fn(() => '/test/path'),
    getAppPath: vi.fn(() => '/test/app'),
    isPackaged: true
  }
}))

const fetchSpy = vi.fn()

describe('LOCK-UPDATER-004 — assistant MCP release check (single Cherry Chat identity)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchSpy)
  })

  it('checkUpdate() returns a disabled result with zero release-feed calls', async () => {
    const { default: AssistantServer } = await import('../assistant')
    const server = new AssistantServer()

    const result = await (server as unknown as { checkUpdate: () => Promise<unknown> }).checkUpdate()

    const text = JSON.stringify(result)
    expect(text).toContain('disabled')
    expect(text).toContain('Cherry Chat')
    // LOCK-UPDATER-004: zero GitHub release/feed/network calls.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('tool descriptions identify the Cherry Chat product name, not Cherry Studio', async () => {
    const { default: AssistantServer } = await import('../assistant')
    const server = new AssistantServer()

    // tools/list is registered on the underlying raw Server, keyed by method.
    const rawServer = (
      server.mcpServer as unknown as {
        server: { _requestHandlers: Map<string, (request: unknown) => Promise<unknown>> }
      }
    ).server
    const listToolsHandler = rawServer._requestHandlers.get('tools/list')
    expect(listToolsHandler).toBeDefined()

    const result = (await listToolsHandler!({ method: 'tools/list', params: {} })) as {
      tools: { name: string; description: string }[]
    }
    const tools = result.tools
    expect(tools).toHaveLength(2)

    for (const tool of tools) {
      expect(tool.description).toContain('Cherry Chat')
      expect(tool.description).not.toContain('Cherry Studio')
    }
  })
})
