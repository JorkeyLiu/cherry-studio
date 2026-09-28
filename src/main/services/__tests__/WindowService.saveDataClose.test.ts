/**
 * Main-window close handshake wiring (WindowService + SaveDataHandshake).
 *
 * Covers: quit-path preventDefault-once → request → ack → destroy (no
 * recursion) + `app.quit()` re-drive; repeat close while pending sends no
 * duplicate request; tray-hide keeps legacy fire-and-forget + hide with no
 * handshake. No sleeps; acks are driven synchronously.
 */
import { IpcChannel } from '@shared/IpcChannel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockApp, mockConfig, FakeWindow, ackHandlers } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  // Minimal emitter (no imports allowed inside vi.hoisted — factories run
  // before module imports are initialized).
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
    public send = vi.fn()
    public mainFrame = { frameId: 1 }
    public isDestroyed = vi.fn(() => false)
    public session = {
      webRequest: { onHeadersReceived: vi.fn() },
      setSpellCheckerLanguages: vi.fn(),
      setSpellCheckerEnabled: vi.fn(),
      flushStorageData: vi.fn(() => undefined)
    }
    public setZoomFactor = vi.fn()
    public setWindowOpenHandler = vi.fn()
    public reload = vi.fn()
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
    public setSize = vi.fn()
    public setMinimumSize = vi.fn()
    public loadURL = vi.fn()
    public loadFile = vi.fn()
    private destroyed = false
    public isDestroyed(): boolean {
      return this.destroyed
    }
    public destroy = vi.fn(() => {
      this.destroyed = true
      this.emit('closed')
    })
  }
  return { mockApp, mockConfig, FakeWindow, ackHandlers: {} as Record<string, (event: unknown, ack: unknown) => void> }
})

vi.mock('electron', () => {
  const mocked = {
    app: mockApp,
    BrowserWindow: FakeWindow,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (event: unknown, ack: unknown) => void) => {
        ackHandlers[channel] = handler
      }),
      removeHandler: vi.fn((channel: string) => {
        delete ackHandlers[channel]
      }),
      on: vi.fn(),
      once: vi.fn()
    },
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
  loggerService: {
    withContext: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
  }
}))

vi.mock('../ConfigManager', () => ({
  configManager: mockConfig
}))

vi.mock('../ThemeService', () => ({}))

vi.mock('../config', () => ({
  titleBarOverlayDark: {},
  titleBarOverlayLight: {}
}))

vi.mock('../ContextMenu', () => ({
  contextMenu: { contextMenu: vi.fn() }
}))

vi.mock('../WebviewService', () => ({
  initSessionUserAgent: vi.fn()
}))

vi.mock('../security', () => ({
  isSafeExternalUrl: () => true
}))

vi.mock('@main/utils/file', () => ({
  getFilesDir: () => '/mock/files'
}))

vi.mock('@main/utils/windowUtil', () => ({
  getWindowsBackgroundMaterial: () => undefined
}))

vi.mock('../../../build/icon.png?asset', () => ({
  default: 'mock-icon'
}))

import { saveDataHandshake } from '../SaveDataHandshake'
import { WindowService } from '../WindowService'

function emitClose(win: InstanceType<typeof FakeWindow>): { preventDefault: ReturnType<typeof vi.fn> } {
  const event = { preventDefault: vi.fn() }
  win.emit('close', event)
  return event
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

describe('WindowService main-window close handshake', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApp.isQuitting = false
    mockConfig.getTray.mockReturnValue(false)
    mockConfig.getTrayOnClose.mockReturnValue(false)
    ;(WindowService as unknown as { instance: unknown }).instance = null
    saveDataHandshake.register()
  })

  afterEach(() => {
    saveDataHandshake.dispose()
    ;(WindowService as unknown as { instance: unknown }).instance = null
  })

  it('quit path: prevents close once, requests save, flushes DOM storage before destroy and re-drives quit', async () => {
    mockApp.isQuitting = true
    const service = WindowService.getInstance()
    const win = service.createMainWindow() as unknown as InstanceType<typeof FakeWindow>

    const event = emitClose(win)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    expect(win.webContents.send.mock.calls[0][0]).toBe(IpcChannel.App_SaveData)
    const payload = win.webContents.send.mock.calls[0][1] as { requestId: string }
    expect(typeof payload.requestId).toBe('string')
    expect(payload.requestId.length).toBeGreaterThan(0)
    expect(win.destroy).not.toHaveBeenCalled()

    ackHandlers[IpcChannel.App_SaveDataAck]?.(
      { sender: win.webContents, senderFrame: win.webContents.mainFrame },
      { requestId: payload.requestId, ok: true, code: 'flushed' }
    )
    await flushMicrotasks()

    const flushMock = win.webContents.session.flushStorageData as ReturnType<typeof vi.fn>
    expect(flushMock).toHaveBeenCalledTimes(1)
    expect(win.destroy).toHaveBeenCalledTimes(1)
    // Durable barrier runs after settle and before destroy.
    expect(flushMock.mock.invocationCallOrder[0]).toBeLessThan(
      (win.destroy as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    )
    // preventDefault aborts the in-flight quit — it must be re-driven.
    expect(mockApp.quit).toHaveBeenCalledTimes(1)
    // DOMStorage-only: never touches cookies or connections.
    expect((win.webContents.session as Record<string, unknown>).cookies).toBeUndefined()
    expect((win.webContents.session as Record<string, unknown>).closeAllConnections).toBeUndefined()
  })

  it('repeat close while a handshake is pending sends no duplicate request and flushes once', async () => {
    mockApp.isQuitting = true
    const service = WindowService.getInstance()
    const win = service.createMainWindow() as unknown as InstanceType<typeof FakeWindow>

    emitClose(win)
    const second = emitClose(win)
    expect(second.preventDefault).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledTimes(1)

    const payload = win.webContents.send.mock.calls[0][1] as { requestId: string }
    ackHandlers[IpcChannel.App_SaveDataAck]?.(
      { sender: win.webContents, senderFrame: win.webContents.mainFrame },
      { requestId: payload.requestId, ok: false, code: 'flush-failed' }
    )
    await flushMicrotasks()
    // acked-failed still runs the durable barrier exactly once.
    expect(win.webContents.session.flushStorageData).toHaveBeenCalledTimes(1)
    expect(win.destroy).toHaveBeenCalledTimes(1)
    expect(mockApp.quit).toHaveBeenCalledTimes(1)
  })

  it('timeout settle still flushes before destroy', async () => {
    mockApp.isQuitting = true
    const service = WindowService.getInstance()
    const win = service.createMainWindow() as unknown as InstanceType<typeof FakeWindow>
    const requestSpy = vi
      .spyOn(saveDataHandshake, 'requestSave')
      .mockResolvedValueOnce({ status: 'timeout', requestId: 'timeout-1' })

    emitClose(win)
    await flushMicrotasks()

    expect(requestSpy).toHaveBeenCalledTimes(1)
    expect(win.webContents.session.flushStorageData).toHaveBeenCalledTimes(1)
    expect(win.destroy).toHaveBeenCalledTimes(1)
    expect(mockApp.quit).toHaveBeenCalledTimes(1)
    requestSpy.mockRestore()
  })

  it('flush throw still destroys and re-drives quit', async () => {
    mockApp.isQuitting = true
    const service = WindowService.getInstance()
    const win = service.createMainWindow() as unknown as InstanceType<typeof FakeWindow>
    ;(win.webContents.session.flushStorageData as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('disk busy')
    })

    emitClose(win)
    const payload = win.webContents.send.mock.calls[0][1] as { requestId: string }
    ackHandlers[IpcChannel.App_SaveDataAck]?.(
      { sender: win.webContents, senderFrame: win.webContents.mainFrame },
      { requestId: payload.requestId, ok: true, code: 'flushed' }
    )
    await flushMicrotasks()

    expect(win.webContents.session.flushStorageData).toHaveBeenCalledTimes(1)
    expect(win.destroy).toHaveBeenCalledTimes(1)
    expect(mockApp.quit).toHaveBeenCalledTimes(1)
  })

  it('skips flush when the window is gone before settle', async () => {
    mockApp.isQuitting = true
    const service = WindowService.getInstance()
    const win = service.createMainWindow() as unknown as InstanceType<typeof FakeWindow>

    emitClose(win)
    expect(saveDataHandshake.hasPending(win as never)).toBe(true)
    // External destroy settles the handshake as window-gone.
    win.destroy()
    await flushMicrotasks()

    expect(win.webContents.session.flushStorageData).not.toHaveBeenCalled()
    // Only the external destroy; the quit handler must not redrive.
    expect(win.destroy).toHaveBeenCalledTimes(1)
    expect(mockApp.quit).not.toHaveBeenCalled()
  })

  it('skips flush when webContents is already destroyed', async () => {
    mockApp.isQuitting = true
    const service = WindowService.getInstance()
    const win = service.createMainWindow() as unknown as InstanceType<typeof FakeWindow>
    ;(win.webContents.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValueOnce(true)
    const requestSpy = vi
      .spyOn(saveDataHandshake, 'requestSave')
      .mockResolvedValueOnce({ status: 'acked-ok', requestId: 'acked-1' })

    emitClose(win)
    await flushMicrotasks()

    expect(win.webContents.session.flushStorageData).not.toHaveBeenCalled()
    expect(win.destroy).toHaveBeenCalledTimes(1)
    expect(mockApp.quit).toHaveBeenCalledTimes(1)
    requestSpy.mockRestore()
  })

  it('tray-hide keeps legacy semantics: fire-and-forget hint, hide, no handshake, no destroy, no flush', async () => {
    mockApp.isQuitting = false
    mockConfig.getTray.mockReturnValue(true)
    mockConfig.getTrayOnClose.mockReturnValue(true)
    const service = WindowService.getInstance()
    const win = service.createMainWindow() as unknown as InstanceType<typeof FakeWindow>

    emitClose(win)
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    // Legacy hint carries no request payload.
    expect(win.webContents.send.mock.calls[0]).toHaveLength(1)
    expect(win.hide).toHaveBeenCalledTimes(1)
    expect(win.destroy).not.toHaveBeenCalled()
    expect(saveDataHandshake.hasPending(win as never)).toBe(false)
    await flushMicrotasks()
    expect(win.webContents.session.flushStorageData).not.toHaveBeenCalled()
    expect(mockApp.quit).not.toHaveBeenCalled()
  })
})
