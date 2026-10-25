/**
 * Preload ChatDb exposure — topic-data export/import surface shape.
 *
 * Proves the REAL `window.api.chatDb` surface built by `src/preload/index.ts`
 * exposes `exportTopicData`/`importTopicData` as functions wired to the exact
 * shared channels — the precise failure reported as
 * `ChatDb API unavailable: topic-data export not exposed` (thrown by
 * SqliteMessageDataSource when the loaded preload predates these methods).
 *
 * Only the Electron transport boundary is mocked (`contextBridge` capture +
 * `ipcRenderer.invoke` capture). The exposed `api` object, the `IpcChannel`
 * enum, and the shared `chatDbContracts` registry are all real and unmocked;
 * no `window.api` object is fabricated. Main-side handler registration for
 * the same channels is proven separately by `ipc.test.ts` (60 handlers).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturedApi, invokeCalls } = vi.hoisted(() => ({
  capturedApi: { api: null as unknown },
  invokeCalls: [] as Array<{ channel: string; request: unknown }>
}))

vi.mock('electron', () => {
  const mocked = {
    contextBridge: {
      exposeInMainWorld: vi.fn((key: string, value: unknown) => {
        if (key === 'api') {
          capturedApi.api = value
        }
      })
    },
    ipcRenderer: {
      invoke: vi.fn((channel: string, request: unknown) => {
        invokeCalls.push({ channel, request })
        return Promise.resolve({ ok: true, value: { payload: null } })
      }),
      on: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn()
    },
    shell: { openExternal: vi.fn() },
    webUtils: { getPathForFile: vi.fn() }
  }
  return { __esModule: true, ...mocked, default: mocked }
})

import { chatDbContracts } from '@shared/chatDb/contracts'
import { IpcChannel } from '@shared/IpcChannel'

vi.mock('@electron-toolkit/preload', () => ({
  electronAPI: { process: { versions: {} } }
}))

describe('Preload chatDb topic-data exposure (real surface)', () => {
  beforeEach(() => {
    invokeCalls.length = 0
    vi.clearAllMocks()
  })

  it('exposes exportTopicData and importTopicData as functions on the real api object', async () => {
    ;(process as unknown as Record<string, unknown>).contextIsolated = true
    await import('../../../../preload/index')

    const api = capturedApi.api as {
      chatDb?: { exportTopicData?: unknown; importTopicData?: unknown }
    }
    expect(api, 'preload must expose the api object via contextBridge').toBeTruthy()
    expect(typeof api.chatDb?.exportTopicData, 'window.api.chatDb.exportTopicData must be exposed').toBe('function')
    expect(typeof api.chatDb?.importTopicData, 'window.api.chatDb.importTopicData must be exposed').toBe('function')
  })

  it('wires both methods to the exact shared channels with request passthrough', async () => {
    ;(process as unknown as Record<string, unknown>).contextIsolated = true
    await import('../../../../preload/index')

    const api = capturedApi.api as {
      chatDb: {
        exportTopicData: (request: unknown) => Promise<unknown>
        importTopicData: (request: unknown) => Promise<unknown>
      }
    }
    const exportRequest = { topicId: 'topic-exposure-probe' }
    const importRequest = { payload: { format: 'cherry-chat-topic-data' }, assistantId: 'assistant-probe' }
    await api.chatDb.exportTopicData(exportRequest)
    await api.chatDb.importTopicData(importRequest)

    expect(invokeCalls).toHaveLength(2)
    expect(invokeCalls[0]?.channel).toBe(IpcChannel.ChatDb_ExportTopicData)
    expect(invokeCalls[0]?.channel).toBe('chatdb:export-topic-data')
    expect(invokeCalls[0]?.request).toBe(exportRequest)
    expect(invokeCalls[1]?.channel).toBe(IpcChannel.ChatDb_ImportTopicData)
    expect(invokeCalls[1]?.channel).toBe('chatdb:import-topic-data')
    expect(invokeCalls[1]?.request).toBe(importRequest)
  })

  it('has matching shared contracts for both invoked channels', () => {
    expect(chatDbContracts['chatdb:export-topic-data']).toBeDefined()
    expect(chatDbContracts['chatdb:import-topic-data']).toBeDefined()
    expect(typeof chatDbContracts['chatdb:export-topic-data'].validate).toBe('function')
    expect(typeof chatDbContracts['chatdb:import-topic-data'].validate).toBe('function')
  })
})
