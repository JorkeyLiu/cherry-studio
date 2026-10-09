/**
 * IpcChannel retired provider surface.
 *
 * Contract: no Copilot, VertexAI, or Anthropic OAuth IPC channels exist on
 * either side of the Main/preload boundary. Every connection authenticates
 * with its configured API key and host.
 */
import { describe, expect, it } from 'vitest'

import { IpcChannel } from '../IpcChannel'

describe('IpcChannel retired provider surface', () => {
  it('exposes no retired Copilot, VertexAI, or Anthropic OAuth channels', () => {
    const values = Object.values(IpcChannel) as string[]
    expect(values.filter((v) => v.startsWith('copilot:'))).toEqual([])
    expect((IpcChannel as Record<string, unknown>).Copilot_GetToken).toBeUndefined()
    expect(values.filter((v) => v.startsWith('vertexai:'))).toEqual([])
    expect((IpcChannel as Record<string, unknown>).VertexAI_GetAuthHeaders).toBeUndefined()
    expect(values.filter((v) => v.startsWith('anthropic:'))).toEqual([])
    expect((IpcChannel as Record<string, unknown>).Anthropic_StartOAuthFlow).toBeUndefined()
    expect((IpcChannel as Record<string, unknown>).Anthropic_CompleteOAuthWithCode).toBeUndefined()
    expect((IpcChannel as Record<string, unknown>).Anthropic_CancelOAuthFlow).toBeUndefined()
    expect((IpcChannel as Record<string, unknown>).Anthropic_GetAccessToken).toBeUndefined()
    expect((IpcChannel as Record<string, unknown>).Anthropic_HasCredentials).toBeUndefined()
    expect((IpcChannel as Record<string, unknown>).Anthropic_ClearCredentials).toBeUndefined()
  })
})
