/**
 * Preload API retired provider surface (slice 3).
 *
 * Module contract test (no UI rendering): the window.api surface exposes no
 * VertexAI/Copilot namespaces, while the Anthropic OAuth namespace remains
 * with its full method set.
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

  it('retains the Anthropic OAuth namespace with its full method set', () => {
    const oauth = getApi().anthropic_oauth
    expect(oauth).toBeDefined()
    for (const method of [
      'startOAuthFlow',
      'completeOAuthWithCode',
      'cancelOAuthFlow',
      'getAccessToken',
      'hasCredentials',
      'clearCredentials'
    ]) {
      expect(typeof oauth?.[method]).toBe('function')
    }
  })
})
