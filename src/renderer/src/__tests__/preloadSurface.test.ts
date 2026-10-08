/**
 * Preload API retired provider surface.
 *
 * Module contract test (no UI rendering): the window.api surface exposes no
 * VertexAI/Copilot namespaces and no Anthropic OAuth namespace. Every
 * connection authenticates with its configured API key and host.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
  shell: { openExternal: vi.fn() },
  webUtils: { getPathForFile: vi.fn() }
}))

vi.mock('@electron-toolkit/preload', () => ({
  electronAPI: {}
}))

await import('../../../preload/index')

type WindowApi = Record<string, Record<string, unknown> | undefined>

const getApi = (): WindowApi => {
  const api = (window as unknown as { api?: WindowApi }).api
  if (!api) throw new Error('window.api was not exposed by the preload module')
  return api
}

describe('preload retired provider surface', () => {
  it('exposes no VertexAI namespace', () => {
    expect(getApi().vertexAI).toBeUndefined()
  })

  it('exposes no Copilot namespace', () => {
    expect(getApi().copilot).toBeUndefined()
  })

  it('exposes no Anthropic OAuth namespace', () => {
    expect(getApi().anthropic_oauth).toBeUndefined()
  })
})
