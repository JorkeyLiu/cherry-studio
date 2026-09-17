/**
 * IpcChannel retired provider surface (slice 3).
 *
 * Contract: no Copilot or VertexAI IPC channels exist on either side of the
 * Main/preload boundary, while the Anthropic OAuth channels remain.
 */
import { describe, expect, it } from 'vitest'

import { IpcChannel } from '../IpcChannel'

describe('IpcChannel retired provider surface', () => {
  it('exposes no Copilot channels', () => {
    const values = Object.values(IpcChannel) as string[]
    expect(values.filter((v) => v.startsWith('copilot:'))).toEqual([])
    expect((IpcChannel as Record<string, unknown>).Copilot_GetToken).toBeUndefined()
  })

  it('exposes no VertexAI channels', () => {
    const values = Object.values(IpcChannel) as string[]
    expect(values.filter((v) => v.startsWith('vertexai:'))).toEqual([])
    expect((IpcChannel as Record<string, unknown>).VertexAI_GetAuthHeaders).toBeUndefined()
  })

  it('retains the Anthropic OAuth channels', () => {
    expect(IpcChannel.Anthropic_StartOAuthFlow).toBe('anthropic:start-oauth-flow')
    expect(IpcChannel.Anthropic_CompleteOAuthWithCode).toBe('anthropic:complete-oauth-with-code')
    expect(IpcChannel.Anthropic_CancelOAuthFlow).toBe('anthropic:cancel-oauth-flow')
    expect(IpcChannel.Anthropic_GetAccessToken).toBe('anthropic:get-access-token')
    expect(IpcChannel.Anthropic_HasCredentials).toBe('anthropic:has-credentials')
    expect(IpcChannel.Anthropic_ClearCredentials).toBe('anthropic:clear-credentials')
  })
})
