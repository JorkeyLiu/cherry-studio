/**
 * Main-side save-data handshake (main window only).
 *
 * Covers: requestId correlation, sender/mainFrame validation, success /
 * failure acks, timeout, destroyed / render-gone windows, duplicate and
 * late acks, single close prevention, dispose. Fake timers only — no sleeps.
 */
import { EventEmitter } from 'node:events'

import { IpcChannel } from '@shared/IpcChannel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIpcHandle, mockIpcRemoveHandler } = vi.hoisted(() => ({
  mockIpcHandle: vi.fn(),
  mockIpcRemoveHandler: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  ipcMain: {
    handle: (...args: unknown[]) => mockIpcHandle(...args),
    removeHandler: (...args: unknown[]) => mockIpcRemoveHandler(...args)
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
  }
}))

import { SaveDataHandshake } from '../SaveDataHandshake'

class FakeContents extends EventEmitter {
  public send = vi.fn()
  public mainFrame = { frameId: 1 }
}

class FakeWindow extends EventEmitter {
  public webContents = new FakeContents()
  private destroyed = false
  public isDestroyed(): boolean {
    return this.destroyed
  }
  public markDestroyed(): void {
    this.destroyed = true
  }
}

type AckEvent = { sender: unknown; senderFrame: unknown }

function ackHandler(): (event: AckEvent, ack: unknown) => void {
  const handler = mockIpcHandle.mock.calls.find(([channel]) => channel === IpcChannel.App_SaveDataAck)?.[1]
  if (!handler) throw new Error('save-data ack handler was not registered')
  return handler as (event: AckEvent, ack: unknown) => void
}

function sentRequestId(win: FakeWindow): string {
  const payload = win.webContents.send.mock.calls[0]?.[1] as { requestId?: string } | undefined
  if (!payload || typeof payload.requestId !== 'string') throw new Error('save-data request was not sent')
  return payload.requestId
}

describe('SaveDataHandshake', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockIpcHandle.mockClear()
    mockIpcRemoveHandler.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers the ack handler once across repeated register() calls', async () => {
    const { SaveDataHandshake: Ctor } = await import('../SaveDataHandshake')
    const hs = new Ctor()
    hs.register()
    hs.register()
    expect(mockIpcHandle.mock.calls.filter(([channel]) => channel === IpcChannel.App_SaveDataAck)).toHaveLength(1)
    hs.dispose()
  })

  it('sends a correlated request and settles acked-ok on success', async () => {
    const hs = new SaveDataHandshake()
    hs.register()
    const win = new FakeWindow()
    const pending = hs.requestSave(win as never, 3000)
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    expect(win.webContents.send.mock.calls[0][0]).toBe(IpcChannel.App_SaveData)
    const requestId = sentRequestId(win)
    expect(requestId.length).toBeGreaterThan(0)
    expect(hs.hasPending(win as never)).toBe(true)

    ackHandler()(
      { sender: win.webContents, senderFrame: win.webContents.mainFrame },
      { requestId, ok: true, code: 'flushed' }
    )
    const result = await pending
    expect(result).toEqual({ status: 'acked-ok', requestId })
    expect(hs.hasPending(win as never)).toBe(false)
    hs.dispose()
  })

  it('settles acked-failed when the renderer reports a flush failure', async () => {
    const hs = new SaveDataHandshake()
    hs.register()
    const win = new FakeWindow()
    const pending = hs.requestSave(win as never, 3000)
    const requestId = sentRequestId(win)
    ackHandler()(
      { sender: win.webContents, senderFrame: win.webContents.mainFrame },
      { requestId, ok: false, code: 'flush-failed' }
    )
    await expect(pending).resolves.toEqual({ status: 'acked-failed', requestId })
    hs.dispose()
  })

  it('settles timeout when no ack arrives', async () => {
    const hs = new SaveDataHandshake()
    hs.register()
    const win = new FakeWindow()
    const pending = hs.requestSave(win as never, 3000)
    const assertion = expect(pending).resolves.toMatchObject({ status: 'timeout' })
    await vi.advanceTimersByTimeAsync(3000)
    await assertion
    expect(hs.hasPending(win as never)).toBe(false)
    hs.dispose()
  })

  it('ignores malformed acks and still times out', async () => {
    const hs = new SaveDataHandshake()
    hs.register()
    const win = new FakeWindow()
    const pending = hs.requestSave(win as never, 1000)
    ackHandler()({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, { ok: true })
    const assertion = expect(pending).resolves.toMatchObject({ status: 'timeout' })
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    hs.dispose()
  })

  it('ignores acks from an unexpected sender', async () => {
    const hs = new SaveDataHandshake()
    hs.register()
    const win = new FakeWindow()
    const other = new FakeContents()
    const pending = hs.requestSave(win as never, 1000)
    const requestId = sentRequestId(win)
    ackHandler()({ sender: other, senderFrame: undefined }, { requestId, ok: true, code: 'flushed' })
    const assertion = expect(pending).resolves.toMatchObject({ status: 'timeout' })
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    hs.dispose()
  })

  it('ignores acks from a non-main frame', async () => {
    const hs = new SaveDataHandshake()
    hs.register()
    const win = new FakeWindow()
    const pending = hs.requestSave(win as never, 1000)
    const requestId = sentRequestId(win)
    ackHandler()({ sender: win.webContents, senderFrame: { frameId: 999 } }, { requestId, ok: true, code: 'flushed' })
    const assertion = expect(pending).resolves.toMatchObject({ status: 'timeout' })
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    hs.dispose()
  })

  it('ignores late acks after timeout and duplicate acks', async () => {
    const hs = new SaveDataHandshake()
    hs.register()
    const win = new FakeWindow()
    const pending = hs.requestSave(win as never, 1000)
    const assertion = expect(pending).resolves.toMatchObject({ status: 'timeout' })
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    const requestId = sentRequestId(win)
    // Late ack for a settled request — must not throw or settle anything new.
    ackHandler()(
      { sender: win.webContents, senderFrame: win.webContents.mainFrame },
      { requestId, ok: true, code: 'flushed' }
    )
    expect(hs.hasPending(win as never)).toBe(false)

    // Duplicate ack on a fresh request: first wins.
    const win2 = new FakeWindow()
    const pending2 = hs.requestSave(win2 as never, 5000)
    const requestId2 = sentRequestId(win2)
    const event = { sender: win2.webContents, senderFrame: win2.webContents.mainFrame }
    ackHandler()(event, { requestId: requestId2, ok: true, code: 'flushed' })
    ackHandler()(event, { requestId: requestId2, ok: false, code: 'flush-failed' })
    await expect(pending2).resolves.toEqual({ status: 'acked-ok', requestId: requestId2 })
    hs.dispose()
  })

  it('settles window-gone when the window closes mid-flight', async () => {
    const hs = new SaveDataHandshake()
    hs.register()
    const win = new FakeWindow()
    const pending = hs.requestSave(win as never, 5000)
    win.emit('closed')
    await expect(pending).resolves.toMatchObject({ status: 'window-gone' })
    hs.dispose()
  })

  it('settles window-gone on render-process-gone (crash)', async () => {
    const hs = new SaveDataHandshake()
    hs.register()
    const win = new FakeWindow()
    const pending = hs.requestSave(win as never, 5000)
    win.webContents.emit('render-process-gone')
    await expect(pending).resolves.toMatchObject({ status: 'window-gone' })
    hs.dispose()
  })

  it('resolves no-window without sending when the window is missing or destroyed', async () => {
    const hs = new SaveDataHandshake()
    hs.register()
    await expect(hs.requestSave(null, 1000)).resolves.toEqual({ status: 'no-window', requestId: '' })
    const win = new FakeWindow()
    win.markDestroyed()
    await expect(hs.requestSave(win as never, 1000)).resolves.toEqual({ status: 'no-window', requestId: '' })
    expect(win.webContents.send).not.toHaveBeenCalled()
    hs.dispose()
  })

  it('settles send-failed when webContents.send throws', async () => {
    const hs = new SaveDataHandshake()
    hs.register()
    const win = new FakeWindow()
    win.webContents.send.mockImplementation(() => {
      throw new Error('receiver gone')
    })
    await expect(hs.requestSave(win as never, 1000)).resolves.toMatchObject({ status: 'send-failed' })
    hs.dispose()
  })

  it('dispose removes the handler and settles in-flight requests as disposed', async () => {
    const hs = new SaveDataHandshake()
    hs.register()
    const win = new FakeWindow()
    const pending = hs.requestSave(win as never, 5000)
    hs.dispose()
    await expect(pending).resolves.toMatchObject({ status: 'disposed' })
    expect(mockIpcRemoveHandler).toHaveBeenCalledWith(IpcChannel.App_SaveDataAck)
    expect(hs.hasPending(win as never)).toBe(false)
  })
})
