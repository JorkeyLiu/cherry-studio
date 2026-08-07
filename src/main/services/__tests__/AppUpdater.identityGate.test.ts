import type { AppIdentity } from '@shared/config/identity'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Module-level mocks mirroring the existing AppUpdater.test.ts harness.
vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn()
    })
  }
}))

vi.mock('../ConfigManager', () => ({
  configManager: {
    getLanguage: vi.fn(() => 'en-US'),
    getAutoUpdate: vi.fn(() => false),
    getTestPlan: vi.fn(() => false),
    getTestChannel: vi.fn(),
    getClientId: vi.fn(() => 'test-client-id')
  }
}))

vi.mock('../WindowService', () => ({
  windowService: {
    getMainWindow: vi.fn()
  }
}))

vi.mock('../AnalyticsService', () => ({
  analyticsService: {
    trackAppUpdate: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@main/constant', () => ({
  isWin: false
}))

vi.mock('@main/utils/ipService', () => ({
  getIpCountry: vi.fn(() => 'US')
}))

vi.mock('@main/utils/locales', () => ({
  locales: {
    en: { translation: { update: {} } },
    'zh-CN': { translation: { update: {} } }
  }
}))

vi.mock('@main/utils/systemInfo', () => ({
  generateUserAgent: vi.fn(() => 'test-user-agent')
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: vi.fn(() => '1.0.0'),
    getPath: vi.fn(() => '/test/path')
  },
  dialog: {
    showMessageBox: vi.fn()
  },
  BrowserWindow: vi.fn(),
  net: {
    fetch: vi.fn()
  }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    logger: null,
    forceDevUpdateConfig: false,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    requestHeaders: {},
    on: vi.fn(),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(() => Promise.resolve({ isUpdateAvailable: false })),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    channel: '',
    allowDowngrade: false,
    disableDifferentialDownload: false,
    currentVersion: '1.0.0'
  },
  Logger: vi.fn(),
  NsisUpdater: vi.fn(),
  AppUpdater: vi.fn()
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

describe('IDENTITY-004 — AppUpdater flavor gate', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('cherry-chat checkForUpdates() returns without any feed/network/update/analytics calls', async () => {
    vi.doMock('@shared/config/identity', () => ({
      appFlavor: 'cherry-chat',
      appIdentity: CHERRY_CHAT_IDENTITY,
      resolveAppIdentity: vi.fn(() => CHERRY_CHAT_IDENTITY),
      APP_FLAVOR_ENV_VAR: 'VITE_APP_FLAVOR'
    }))

    const { default: AppUpdater } = await import('../AppUpdater')
    const { analyticsService } = await import('../AnalyticsService')
    const { autoUpdater } = await import('electron-updater')
    const { app, net } = await import('electron')

    const updater = new AppUpdater()
    const result = await updater.checkForUpdates()

    expect(result).toEqual({ currentVersion: '1.0.0', updateInfo: null })

    // IDENTITY-004: zero feed/network/update/analytics side effects.
    expect(net.fetch).not.toHaveBeenCalled()
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled()
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(analyticsService.trackAppUpdate).not.toHaveBeenCalled()
    expect(app.getVersion).toHaveBeenCalled()
  })

  it('cherry-studio checkForUpdates() proceeds to feed resolution (gate is flavor-specific)', async () => {
    vi.doMock('@shared/config/identity', () => ({
      appFlavor: 'cherry-studio',
      appIdentity: CHERRY_STUDIO_IDENTITY,
      resolveAppIdentity: vi.fn(() => CHERRY_STUDIO_IDENTITY),
      APP_FLAVOR_ENV_VAR: 'VITE_APP_FLAVOR'
    }))

    const { default: AppUpdater } = await import('../AppUpdater')
    const { analyticsService } = await import('../AnalyticsService')
    const { autoUpdater } = await import('electron-updater')
    const { net } = await import('electron')

    const updater = new AppUpdater()

    // Feed config fetch fails (HTTP 404) — updater falls back to the default feed URL.
    vi.mocked(net.fetch).mockResolvedValue({ ok: false, status: 404 } as Response)
    const result = await updater.checkForUpdates()

    // The default flavor performs the normal feed-resolution flow.
    expect(net.fetch).toHaveBeenCalled()
    expect(autoUpdater.setFeedURL).toHaveBeenCalled()
    expect(autoUpdater.checkForUpdates).toHaveBeenCalled()
    expect(analyticsService.trackAppUpdate).toHaveBeenCalled()
    expect(result).toEqual({ currentVersion: '1.0.0', updateInfo: null })
  })
})
