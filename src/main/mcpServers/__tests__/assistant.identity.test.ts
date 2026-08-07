import type { AppIdentity } from '@shared/config/identity'
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

const CHERRY_CHAT_IDENTITY: AppIdentity = {
  flavor: 'cherry-chat',
  productName: 'Cherry Chat',
  appId: 'com.jorkeyliu.CherryChat',
  protocolScheme: 'cherrychat',
  protocolUrlScheme: 'cherrychat://',
  protocolDisplayName: 'Cherry Chat',
  homeDirName: '.cherrychat',
  userDataDirName: 'Cherry Chat',
  genericTempDirName: 'CherryChat',
  tempDirName: 'cherry-chat',
  updaterEnabled: false,
  analyticsChannel: 'cherry-chat',
  userAgentProduct: 'CherryChat',
  apiTitle: 'Cherry Chat API',
  linuxClassAndName: 'CherryChat',
  crashReporterProductName: 'CherryChat'
}

const CHERRY_STUDIO_IDENTITY: AppIdentity = {
  flavor: 'cherry-studio',
  productName: 'Cherry Studio',
  appId: 'com.kangfenmao.CherryStudio',
  protocolScheme: 'cherrystudio',
  protocolUrlScheme: 'cherrystudio://',
  protocolDisplayName: 'Cherry Studio',
  homeDirName: '.cherrystudio',
  userDataDirName: 'Cherry Studio',
  genericTempDirName: 'CherryStudio',
  tempDirName: 'cherry-studio',
  updaterEnabled: true,
  analyticsChannel: 'cherry-studio',
  userAgentProduct: 'CherryStudio',
  apiTitle: 'Cherry Studio API',
  linuxClassAndName: 'CherryStudio',
  crashReporterProductName: 'CherryStudio'
}

const fetchSpy = vi.fn()

describe('IDENTITY-004 — assistant MCP release check', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchSpy)
  })

  it('cherry-chat checkUpdate() returns a disabled result with zero release-feed calls', async () => {
    vi.doMock('@shared/config/identity', () => ({
      appFlavor: 'cherry-chat',
      appIdentity: CHERRY_CHAT_IDENTITY,
      resolveAppIdentity: vi.fn(() => CHERRY_CHAT_IDENTITY),
      APP_FLAVOR_ENV_VAR: 'VITE_APP_FLAVOR'
    }))

    const { default: AssistantServer } = await import('../assistant')
    const server = new AssistantServer()

    const result = await (server as unknown as { checkUpdate: () => Promise<unknown> }).checkUpdate()

    const text = JSON.stringify(result)
    expect(text).toContain('disabled')
    expect(text).toContain('Cherry Chat')
    // IDENTITY-004: zero GitHub release/feed/network calls.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('cherry-studio checkUpdate() queries the GitHub release feed with the derived UA', async () => {
    vi.doMock('@shared/config/identity', () => ({
      appFlavor: 'cherry-studio',
      appIdentity: CHERRY_STUDIO_IDENTITY,
      resolveAppIdentity: vi.fn(() => CHERRY_STUDIO_IDENTITY),
      APP_FLAVOR_ENV_VAR: 'VITE_APP_FLAVOR'
    }))

    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v1.1.0',
        name: 'v1.1.0',
        html_url: 'https://github.com/CherryHQ/cherry-studio/releases/tag/v1.1.0',
        published_at: '2026-01-01T00:00:00Z'
      })
    })

    const { default: AssistantServer } = await import('../assistant')
    const server = new AssistantServer()

    const result = await (server as unknown as { checkUpdate: () => Promise<unknown> }).checkUpdate()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(url).toBe('https://api.github.com/repos/CherryHQ/cherry-studio/releases/latest')
    expect(init.headers['User-Agent']).toBe('CherryStudio')
    const text = (result as { content: { text: string }[] }).content[0].text
    expect(JSON.parse(text)).toMatchObject({ latestVersion: '1.1.0', releaseUrl: expect.any(String) })
  })
})
