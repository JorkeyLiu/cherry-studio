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

describe('LOCK-UPDATER-004 — AppUpdater identity gate (single Cherry Chat identity)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('checkForUpdates() returns without any feed/network/update/analytics calls', async () => {
    const { default: AppUpdater } = await import('../AppUpdater')
    const { analyticsService } = await import('../AnalyticsService')
    const { autoUpdater } = await import('electron-updater')
    const { app, net } = await import('electron')

    const updater = new AppUpdater()
    const result = await updater.checkForUpdates()

    expect(result).toEqual({ currentVersion: '1.0.0', updateInfo: null })

    // LOCK-UPDATER-004: zero feed/network/update/analytics side effects.
    expect(net.fetch).not.toHaveBeenCalled()
    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled()
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    expect(analyticsService.trackAppUpdate).not.toHaveBeenCalled()
    expect(app.getVersion).toHaveBeenCalled()
  })
})
