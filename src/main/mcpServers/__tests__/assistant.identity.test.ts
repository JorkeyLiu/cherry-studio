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
})
