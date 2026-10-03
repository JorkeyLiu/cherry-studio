// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { providersMock } = vi.hoisted(() => ({
  providersMock: vi.fn(() => [] as any)
}))

vi.mock('@renderer/hooks/useStore', () => ({
  getStoreProviders: providersMock,
  useStoreProviders: vi.fn()
}))
vi.mock('@renderer/store', () => ({
  default: { getState: vi.fn(() => ({ llm: { defaultModel: undefined, providers: [] } })) }
}))
vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }
}))
vi.mock('@renderer/i18n', () => ({ default: { t: (k: string) => k } }))

import { getAssistantProvider, getProviderByModel } from '../AssistantService'

describe('AssistantService strict exact selection (C1)', () => {
  const providerA = { id: 'provider-a', name: 'A', models: [] } as any
  const providerB = { id: 'provider-b', name: 'B', models: [] } as any
  const defaultModel = { id: 'm-default', provider: 'provider-a', name: 'default' } as any
  const staleModel = { id: 'm-stale', provider: 'deleted-provider', name: 'stale' } as any
  const unknownModel = { id: 'm-unknown', provider: 'provider-a', name: 'unknown' } as any

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getProviderByModel returns undefined for missing provider (no default fallback)', async () => {
    providersMock.mockReturnValue([providerA])
    // defaultModel points to provider-a, but staleModel points to deleted-provider
    // getProviderByModel(stale) must not fall back to provider-a
    const { getProviderByModel: gpm } = await import('../AssistantService')
    expect(gpm(staleModel)).toBeUndefined()
  })

  it('getProviderByModel returns exact provider for valid model', async () => {
    providersMock.mockReturnValue([providerA, providerB])
    const { getProviderByModel: gpm } = await import('../AssistantService')
    expect(gpm(unknownModel)).toBe(providerA)
  })

  it('getProviderByModel returns undefined for undefined model (no implicit default)', async () => {
    providersMock.mockReturnValue([providerA])
    const { getProviderByModel: gpm } = await import('../AssistantService')
    expect(gpm(undefined)).toBeUndefined()
  })

  it('getAssistantProvider returns undefined for stale assistant model (no default fallback)', () => {
    providersMock.mockReturnValue([providerA])
    const assistant = { id: 'a1', model: staleModel } as any
    expect(getAssistantProvider(assistant)).toBeUndefined()
  })

  it('getAssistantProvider returns exact provider for valid assistant', () => {
    providersMock.mockReturnValue([providerA, providerB])
    const assistant = { id: 'a1', model: unknownModel } as any
    expect(getAssistantProvider(assistant)).toBe(providerA)
  })

  it('specified unknown connection never resolves to default provider', () => {
    providersMock.mockReturnValue([providerA, providerB])
    // stale model provider not in store -> must be undefined, not providerA fallback
    expect(getProviderByModel(staleModel)).toBeUndefined()
    // unknown model with valid exact provider -> resolves to that provider
    expect(getProviderByModel(unknownModel)).toBe(providerA)
  })
})
