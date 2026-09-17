/**
 * Main formatProviderApiHost protocol selection (slice 3).
 *
 * Contract: host formatting is protocol-driven only. Gemini uses the v1beta
 * variant; every other approved OpenAI-compatible entry uses the generic
 * formatter. Retired protocols (azure/vertex/ollama-legacy/bedrock/gateway)
 * fall through to the generic formatter — no brand-id or retired-protocol
 * formatters exist in the active path.
 */
import type { Provider } from '@types'
import { describe, expect, it } from 'vitest'

import { formatProviderApiHost } from '../providerConfig'

const makeProvider = (overrides: Partial<Provider> & { id: string }): Provider =>
  ({
    name: overrides.id,
    type: 'openai',
    apiKey: 'k',
    apiHost: 'https://proxy.example.com',
    models: [],
    enabled: true,
    ...overrides
  }) as Provider

describe('main formatProviderApiHost protocol selection', () => {
  it('formats Gemini hosts with the v1beta variant', async () => {
    const formatted = await formatProviderApiHost(
      makeProvider({ id: 'gemini', type: 'gemini', apiHost: 'https://generativelanguage.googleapis.com' })
    )
    expect(formatted.apiHost).toBe('https://generativelanguage.googleapis.com/v1beta')
  })

  it('formats generic OpenAI-compatible entries brand-independently', async () => {
    const formatted = await formatProviderApiHost(makeProvider({ id: 'my-brand', type: 'openai' }))
    expect(formatted.apiHost).toBe('https://proxy.example.com/v1')
  })

  it('falls retired protocols through to the generic formatter without brand handling', async () => {
    for (const [id, type, apiHost, expected] of [
      ['azure-openai', 'azure-openai', 'https://my-azure.example.com', 'https://my-azure.example.com/v1'],
      ['vertexai', 'vertexai', 'https://vertex.example.com', 'https://vertex.example.com/v1'],
      ['ollama-legacy', 'ollama', 'http://localhost:11434', 'http://localhost:11434/v1'],
      ['aws-bedrock', 'aws-bedrock', 'https://bedrock.example.com', 'https://bedrock.example.com/v1'],
      ['gateway', 'gateway', 'https://gateway.example.com', 'https://gateway.example.com/v1']
    ] as const) {
      const formatted = await formatProviderApiHost(
        makeProvider({ id, type: type as unknown as Provider['type'], apiHost })
      )
      expect(formatted.apiHost).toBe(expected)
      // No retired-protocol URL shapes (vertex publishers, azure /openai suffix, ollama /api).
      expect(formatted.apiHost).not.toContain('publishers')
      expect(formatted.apiHost).not.toMatch(/\/openai$/)
      expect(formatted.apiHost).not.toMatch(/\/api$/)
    }
  })

  it('syncs the Anthropic dual host fields without brand handling', async () => {
    const formatted = await formatProviderApiHost(
      makeProvider({
        id: 'anthropic',
        type: 'anthropic',
        apiHost: 'https://api.anthropic.com',
        anthropicApiHost: 'https://api.anthropic.com'
      })
    )
    expect(formatted.apiHost).toBe('https://api.anthropic.com/v1')
    expect(formatted.anthropicApiHost).toBe('https://api.anthropic.com/v1')
  })
})
