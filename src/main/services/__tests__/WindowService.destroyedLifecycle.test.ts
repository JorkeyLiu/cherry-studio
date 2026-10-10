/**
 * Destroyed WebContents lifecycle: closing/tearing-down a window must never
 * call native WebContents methods after destroy (uncaught `TypeError: Object
 * has been destroyed` inside `WebContents.emit`), while genuine live-renderer
 * crash recovery and zoom behavior stay intact.
 *
 * Uses throwing fakes that mimic Electron: reload/setZoomFactor/send throw
 * synchronously when the contents are destroyed, exactly like the production
 * `Object has been destroyed` path. Under the old unguarded
 * `render-process-gone → reload()` handler, the destroyed-event cases below
 * throw inside `emit` (old-code FAIL); the fixed handler skips before any
 * native call (fixed PASS).
 */
import { IpcChannel } from '@shared/IpcChannel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockApp, mockConfig, FakeWindow } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  class MiniEmitter {
    private listeners = new Map<string, Listener[]>()
    public on(event: string, fn: Listener): void {
      const list = this.listeners.get(event) ?? []
      list.push(fn)
      this.listeners.set(event, list)
    }
    public once(event: string, fn: Listener): void {
      const wrapped = (...args: unknown[]): void => {
        this.removeListener(event, wrapped)
        fn(...args)
      }
      this.on(event, wrapped)
    }
    public removeListener(event: string, fn: Listener): void {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((l) => l !== fn)
      )
    }
    public emit(event: string, ...args: unknown[]): void {
      for (const fn of [...(this.listeners.get(event) ?? [])]) {
        fn(...args)
      }
    }
  }
  const mockApp = {
    isQuitting: false,
    quit: vi.fn(),
    exit: vi.fn(),
    on: vi.fn(),
    getPath: vi.fn(() => '/mock/userData'),
    setPath: vi.fn(),
    dock: { show: vi.fn(), hide: vi.fn() }
  }
  const mockConfig = {
    getTray: vi.fn(() => false),
    getTrayOnClose: vi.fn(() => false),
    getZoomFactor: vi.fn(() => 1),
    getLaunchToTray: vi.fn(() => false),
    getUseSystemTitleBar: vi.fn(() => false),
    get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue)
  }
  class FakeContents extends MiniEmitter {
    public destroyedFlag = false
    public send = vi.fn((..._args: unknown[]) => {
      if (this.destroyedFlag) {
        throw new TypeError('Object has been destroyed')
      }
    })
    public mainFrame = { frameId: 1 }
    public isDestroyed = vi.fn(() => this.destroyedFlag)
    public session = {
      webRequest: { onHeadersReceived: vi.fn() },
      setSpellCheckerLanguages: vi.fn(),
      flushStorageData: vi.fn(() => undefined)
    }
    public setZoomFactor = vi.fn((_f: number) => {
      if (this.destroyedFlag) {
        throw new TypeError('Object has been destroyed')
      }
    })
    public setWindowOpenHandler = vi.fn()
    public reload = vi.fn(() => {
      if (this.destroyedFlag) {
        throw new TypeError('Object has been destroyed')
      }
    })
    public markDestroyed(): void {
      this.destroyedFlag = true
    }
  }
  class FakeWindow extends MiniEmitter {
    public webContents = new FakeContents()
    public show = vi.fn()
    public focus = vi.fn()
    public hide = vi.fn()
    public maximize = vi.fn()
    public restore = vi.fn()
    public setVisibleOnAllWorkspaces = vi.fn()
    public setFullScreen = vi.fn()
    public isFullScreen = vi.fn(() => false)
    public isMinimized = vi.fn(() => false)
    public isVisible = vi.fn(() => true)
    public isFocused = vi.fn(() => true)
    public isMaximized = vi.fn(() => false)
    public getSize = vi.fn((): [number, number] => [1200, 800])
    public loadURL = vi.fn()
    public loadFile = vi.fn()
    private destroyed = false
    public isDestroyed(): boolean {
      return this.destroyed
    }
    public markDestroyed(): void {
      this.destroyed = true
      this.webContents.markDestroyed()
    }
    public destroy = vi.fn(() => {
      this.destroyed = true
      this.webContents.markDestroyed()
      this.emit('closed')
    })
  }
  return { mockApp, mockConfig, FakeWindow }
})

vi.mock('electron', () => {
  const mocked = {
    app: mockApp,
    BrowserWindow: FakeWindow,
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), once: vi.fn() },
    nativeImage: { createFromPath: vi.fn(() => ({})) },
    nativeTheme: { shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() },
    shell: { openExternal: vi.fn(), openPath: vi.fn() }
  }
  return { __esModule: true, ...mocked, default: mocked }
})

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false },
  optimizer: { watchWindowShortcuts: vi.fn() }
}))
vi.mock('electron-window-state', () => ({
  default: () => ({ manage: vi.fn(), isMaximized: false, x: 0, y: 0, width: 1200, height: 800 })
}))
vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }
}))
vi.mock('../ConfigManager', () => ({ configManager: mockConfig }))
vi.mock('../ThemeService', () => ({}))
vi.mock('../config', () => ({ titleBarOverlayDark: {}, titleBarOverlayLight: {} }))
vi.mock('../ContextMenu', () => ({ contextMenu: { contextMenu: vi.fn() } }))
vi.mock('../WebviewService', () => ({ initSessionUserAgent: vi.fn() }))
vi.mock('../security', () => ({ isSafeExternalUrl: () => true }))
vi.mock('@main/utils/file', () => ({ getFilesDir: () => '/mock/files' }))
vi.mock('@main/utils/windowUtil', () => ({ getWindowsBackgroundMaterial: () => undefined }))
vi.mock('../../../build/icon.png?asset', () => ({ default: 'mock-icon' }))

import { WindowService } from '../WindowService'

type FakeWin = InstanceType<typeof FakeWindow>

function resetService(): void {
  ;(WindowService as unknown as { instance: unknown }).instance = null
}

function emitRenderGone(win: FakeWin, reason = 'killed'): void {
  win.webContents.emit('render-process-gone', {}, { reason })
}

describe('WindowService destroyed-lifecycle guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    mockApp.isQuitting = false
    mockConfig.getTray.mockReturnValue(false)
    mockConfig.getTrayOnClose.mockReturnValue(false)
    resetService()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetService()
  })

  it('destroyed window render-process-gone never calls reload (old code threw inside emit)', () => {
    const service = WindowService.getInstance()
    const win = service.createMainWindow() as unknown as FakeWin
    win.markDestroyed()
    expect(() => emitRenderGone(win, 'killed')).not.toThrow()
    expect(win.webContents.reload).not.toHaveBeenCalled()
    expect(mockApp.exit).not.toHaveBeenCalled()
  })

  it('destroyed contents render-process-gone never calls reload', () => {
    const service = WindowService.getInstance()
    const win = service.createMainWindow() as unknown as FakeWin
    // Window shell alive but contents gone (teardown ordering edge).
    ;(win.webContents as unknown as { destroyedFlag: boolean }).destroyedFlag = true
    expect(() => emitRenderGone(win, 'killed')).not.toThrow()
    expect(win.webContents.reload).not.toHaveBeenCalled()
    expect(mockApp.exit).not.toHaveBeenCalled()
  })

  it('quitting live window skips reload/exit (owned shutdown, not a crash)', () => {
    mockApp.isQuitting = true
    const service = WindowService.getInstance()
    const win = service.createMainWindow() as unknown as FakeWin
    expect(() => emitRenderGone(win, 'crashed')).not.toThrow()
    expect(win.webContents.reload).not.toHaveBeenCalled()
    expect(mockApp.exit).not.toHaveBeenCalled()
  })

  it('stale-window callback cannot act on the replacement window', () => {
    const service = WindowService.getInstance()
    const oldWin = service.createMainWindow() as unknown as FakeWin
    oldWin.markDestroyed()
    // 'closed' clears service.mainWindow; creating again yields replacement.
    oldWin.emit('closed')
    const newWin = service.createMainWindow() as unknown as FakeWin
    expect(newWin).not.toBe(oldWin)
    // Late event on the old (destroyed) contents must not reload, exit, or
    // touch the replacement.
    expect(() => emitRenderGone(oldWin, 'crashed')).not.toThrow()
    expect(oldWin.webContents.reload).not.toHaveBeenCalled()
    expect(newWin.webContents.reload).not.toHaveBeenCalled()
    expect(mockApp.exit).not.toHaveBeenCalled()
  })

  it('teardown event does not poison the crash window: next live crash still reloads', () => {
    const service = WindowService.getInstance()
    const win = service.createMainWindow() as unknown as FakeWin
    win.markDestroyed()
    emitRenderGone(win, 'killed')
    oldWinClosedSetup(service, win)
    const live = service.getMainWindow() as unknown as FakeWin
    emitRenderGone(live, 'crashed')
    expect(live.webContents.reload).toHaveBeenCalledTimes(1)
    expect(mockApp.exit).not.toHaveBeenCalled()
  })

  it('live crashed renderer still recovers via reload', () => {
    const service = WindowService.getInstance()
    const win = service.createMainWindow() as unknown as FakeWin
    expect(() => emitRenderGone(win, 'crashed')).not.toThrow()
    expect(win.webContents.reload).toHaveBeenCalledTimes(1)
    expect(mockApp.exit).not.toHaveBeenCalled()
  })

  it('did-navigate-in-page after destroy skips setZoomFactor; live still zooms', () => {
    const service = WindowService.getInstance()
    const win = service.createMainWindow() as unknown as FakeWin
    win.webContents.emit('did-navigate-in-page')
    expect(win.webContents.setZoomFactor).toHaveBeenCalledTimes(1)
    ;(win.webContents.setZoomFactor as ReturnType<typeof vi.fn>).mockClear()
    win.markDestroyed()
    expect(() => win.webContents.emit('did-navigate-in-page')).not.toThrow()
    expect(win.webContents.setZoomFactor).not.toHaveBeenCalled()
  })

  it('quoteToMainWindow deferred send skips a window destroyed in the gap', () => {
    vi.useFakeTimers()
    const service = WindowService.getInstance()
    const win = service.createMainWindow() as unknown as FakeWin
    service.quoteToMainWindow('hello')
    win.markDestroyed()
    expect(() => vi.runAllTimers()).not.toThrow()
    expect(win.webContents.send).not.toHaveBeenCalledWith(IpcChannel.App_QuoteToMain, expect.anything())
  })

  it('quoteToMainWindow deferred send still delivers when live', () => {
    vi.useFakeTimers()
    const service = WindowService.getInstance()
    const win = service.createMainWindow() as unknown as FakeWin
    service.quoteToMainWindow('hello')
    vi.runAllTimers()
    expect(win.webContents.send).toHaveBeenCalledWith(IpcChannel.App_QuoteToMain, 'hello')
  })
})

function oldWinClosedSetup(service: WindowService, oldWin: FakeWin): void {
  oldWin.emit('closed')
  // Recreate replacement so getMainWindow() is live for the next assertion.
  service.createMainWindow()
}
