import type { Model, Provider } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }
}))

import type { ModelMetadataSnapshot } from '@shared/modelMetadata'

import {
  getModelMetadataStatus,
  getModelMetadataStatusSnapshot,
  initModelMetadataRegistry,
  lookupModelMetadata,
  normalizeApiUrl,
  refreshModelMetadataRegistry,
  resolveMetadataSource,
  resolveModelMetadata,
  resolveProviderForMetadata,
  setMetadataProviderResolver,
  setModelMetadataSnapshotForTests,
  setModelMetadataStatusForTests,
  subscribeModelMetadataStatus
} from '../modelMetadata'

const SNAPSHOT: ModelMetadataSnapshot = {
  source: 'models.dev',
  fetchedAt: 1_000_000,
  providers: {
    anthropic: {
      api: '',
      name: 'Anthropic',
      models: {
        'claude-sonnet-4-6': {
          id: 'claude-sonnet-4-6',
          modalities: { input: ['text', 'image'], output: ['text'] },
          toolCall: true,
          reasoning: true
        }
      }
    },
    openai: {
      api: '',
      name: 'OpenAI',
      models: {
        'gpt-5-mini': {
          id: 'gpt-5-mini',
          modalities: { input: ['text'], output: ['text'] },
          toolCall: true,
          reasoning: false
        }
      }
    },
    google: {
      api: '',
      name: 'Google',
      models: {
        'gemini-3-flash': {
          id: 'gemini-3-flash',
          modalities: { input: ['text', 'image'], output: ['text'] },
          reasoning: true
        }
      }
    },
    'party-a': {
      api: 'https://api.party-a.example/v1',
      name: 'Party A',
      models: { 'party-a/model-x': { id: 'party-a/model-x', modalities: { input: ['text'], output: ['text'] } } }
    },
    'party-b': {
      api: 'https://api.party-b.example/v1/',
      name: 'Party B',
      models: {}
    },
    'party-dup': {
      api: 'https://api.party-a.example/v1/',
      name: 'Party Dup',
      models: {}
    }
  }
}

const makeProvider = (overrides: Partial<Provider> & { id: string; type: Provider['type'] }): Provider =>
  ({ name: overrides.id, apiKey: '', apiHost: '', models: [], ...overrides }) as Provider

const makeModel = (id: string, provider: string): Model => ({ id, name: id, provider, group: provider }) as Model

describe('normalizeApiUrl', () => {
  it('normalizes trailing slashes and host case for exact comparison', () => {
    expect(normalizeApiUrl('https://api.party-b.example/v1/')).toBe('https://api.party-b.example/v1')
    expect(normalizeApiUrl('HTTPS://API.PARTY-B.EXAMPLE/v1')).toBe('https://api.party-b.example/v1')
    expect(normalizeApiUrl('  https://api.party-b.example/v1  ')).toBe('https://api.party-b.example/v1')
    expect(normalizeApiUrl('')).toBe('')
    expect(normalizeApiUrl(undefined)).toBe('')
  })

  it('refuses to match URLs carrying userinfo/query/hash', () => {
    expect(normalizeApiUrl('https://api.party-b.example/v1?key=secret')).toBe('')
    expect(normalizeApiUrl('https://user:pass@api.party-b.example/v1')).toBe('')
    expect(normalizeApiUrl('https://user@api.party-b.example/v1')).toBe('')
    expect(normalizeApiUrl('https://api.party-b.example/v1#fragment')).toBe('')
    expect(normalizeApiUrl('not a url?x=1')).toBe('')
    expect(normalizeApiUrl('not a url#x')).toBe('')
  })
})

describe('resolveMetadataSource', () => {
  it('maps anthropic protocol to anthropic and gemini to google (never google-vertex)', () => {
    expect(resolveMetadataSource(makeProvider({ id: 'a', type: 'anthropic' }), SNAPSHOT)).toBe('anthropic')
    expect(resolveMetadataSource(makeProvider({ id: 'g', type: 'gemini' }), SNAPSHOT)).toBe('google')
  })

  it('maps the official OpenAI host to openai', () => {
    expect(
      resolveMetadataSource(makeProvider({ id: 'o', type: 'openai', apiHost: 'https://api.openai.com/v1' }), SNAPSHOT)
    ).toBe('openai')
    expect(
      resolveMetadataSource(makeProvider({ id: 'o', type: 'openai', apiHost: 'https://api.openai.com/v1/' }), SNAPSHOT)
    ).toBe('openai')
  })

  it('matches other OpenAI-compatible hosts only on exactly one normalized api URL', () => {
    // party-b has a unique api URL (trailing-slash-insensitive)
    expect(
      resolveMetadataSource(
        makeProvider({ id: 'c', type: 'openai', apiHost: 'https://api.party-b.example/v1' }),
        SNAPSHOT
      )
    ).toBe('party-b')
    // party-a's URL is shared by two sources -> ambiguous -> unknown
    expect(
      resolveMetadataSource(
        makeProvider({ id: 'c', type: 'openai', apiHost: 'https://api.party-a.example/v1/' }),
        SNAPSHOT
      )
    ).toBeNull()
    // unmapped host -> unknown, never another source
    expect(
      resolveMetadataSource(makeProvider({ id: 'c', type: 'openai', apiHost: 'https://unknown.example/v9' }), SNAPSHOT)
    ).toBeNull()
  })

  it('never conflates endpoints by dropping query/userinfo/hash', () => {
    // each variant would normalize to party-b's plain URL if query/userinfo/
    // hash were dropped — all must refuse instead
    for (const apiHost of [
      'https://api.party-b.example/v1?key=secret',
      'https://api.party-b.example/v1?key=secret&other=1',
      'https://user:pass@api.party-b.example/v1',
      'https://user@api.party-b.example/v1',
      'https://api.party-b.example/v1#fragment'
    ]) {
      expect(resolveMetadataSource(makeProvider({ id: 'c', type: 'openai', apiHost }), SNAPSHOT)).toBeNull()
    }
    // a snapshot-side api carrying a query is excluded from matching even
    // against its own plain-URL form
    const withQuerySource: ModelMetadataSnapshot = {
      ...SNAPSHOT,
      providers: {
        ...SNAPSHOT.providers,
        'party-q': { api: 'https://api.unique-q.example/v1?key=1', name: 'Party Q', models: {} }
      }
    }
    expect(
      resolveMetadataSource(
        makeProvider({ id: 'c', type: 'openai', apiHost: 'https://api.unique-q.example/v1' }),
        withQuerySource
      )
    ).toBeNull()
  })

  it('returns null without provider or snapshot', () => {
    expect(resolveMetadataSource(null, SNAPSHOT)).toBeNull()
    expect(resolveMetadataSource(makeProvider({ id: 'a', type: 'anthropic' }), null)).toBeNull()
  })
})

describe('lookupModelMetadata — exact id only', () => {
  it('finds exact trimmed ids and rejects fuzzy variants', () => {
    expect(lookupModelMetadata('anthropic', 'claude-sonnet-4-6', SNAPSHOT)?.id).toBe('claude-sonnet-4-6')
    expect(lookupModelMetadata('anthropic', '  claude-sonnet-4-6  ', SNAPSHOT)?.id).toBe('claude-sonnet-4-6')
    // no lowercasing, no suffix stripping, no partial match
    expect(lookupModelMetadata('anthropic', 'Claude-Sonnet-4-6', SNAPSHOT)).toBeUndefined()
    expect(lookupModelMetadata('anthropic', 'claude-sonnet-4', SNAPSHOT)).toBeUndefined()
    expect(lookupModelMetadata('anthropic', 'claude-sonnet', SNAPSHOT)).toBeUndefined()
    expect(lookupModelMetadata('anthropic', '', SNAPSHOT)).toBeUndefined()
  })

  it('never falls back to another source on a miss', () => {
    // gpt-5-mini exists in openai but the lookup is scoped to anthropic
    expect(lookupModelMetadata('anthropic', 'gpt-5-mini', SNAPSHOT)).toBeUndefined()
    expect(lookupModelMetadata('no-such-source', 'gpt-5-mini', SNAPSHOT)).toBeUndefined()
    expect(lookupModelMetadata('openai', 'gpt-5-mini', null)).toBeUndefined()
  })

  it('rejects unsafe dictionary keys and malformed shapes without throwing', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(lookupModelMetadata('anthropic', key, SNAPSHOT)).toBeUndefined()
      expect(lookupModelMetadata(key, 'claude-sonnet-4-6', SNAPSHOT)).toBeUndefined()
    }
    const malformed = [
      { providers: null },
      { providers: { anthropic: null } },
      { providers: { anthropic: { models: null } } },
      { providers: { anthropic: { models: 'nope' } } },
      { providers: 'nope' },
      null
    ]
    for (const shape of malformed) {
      expect(lookupModelMetadata('anthropic', 'claude-sonnet-4-6', shape as never)).toBeUndefined()
      expect(
        resolveMetadataSource(
          makeProvider({ id: 'c', type: 'openai', apiHost: 'https://x.example/v1' }),
          shape as never
        )
      ).toBeNull()
    }
  })
})

describe('resolveModelMetadata', () => {
  it('combines source mapping with exact lookup', () => {
    const provider = makeProvider({ id: 'a', type: 'anthropic' })
    expect(resolveModelMetadata(makeModel('claude-sonnet-4-6', 'a'), provider, SNAPSHOT)?.toolCall).toBe(true)
    expect(resolveModelMetadata(makeModel('custom-unknown-1', 'a'), provider, SNAPSHOT)).toBeUndefined()
    expect(resolveModelMetadata(undefined, provider, SNAPSHOT)).toBeUndefined()
  })
})

describe('resolveProviderForMetadata — injected accessor, exact match only', () => {
  const provider = makeProvider({ id: 'a', type: 'anthropic' })

  it('returns null without a registered resolver (never a silent fallback)', () => {
    setMetadataProviderResolver(null)
    expect(resolveProviderForMetadata(makeModel('m', 'a'))).toBeNull()
    expect(resolveProviderForMetadata(undefined)).toBeNull()
    expect(resolveProviderForMetadata(makeModel('m', ''))).toBeNull()
  })

  it('accepts only resolver results whose id equals the model provider', () => {
    setMetadataProviderResolver((model) => (model?.provider === 'a' ? provider : undefined))
    try {
      expect(resolveProviderForMetadata(makeModel('m', 'a'))).toBe(provider)
      expect(resolveProviderForMetadata(makeModel('m', 'deleted'))).toBeNull()
      // explicit provider wins, including explicit null = known absent
      const other = makeProvider({ id: 'other', type: 'openai' })
      expect(resolveProviderForMetadata(makeModel('m', 'a'), other)).toBe(other)
      expect(resolveProviderForMetadata(makeModel('m', 'a'), null)).toBeNull()
      // a throwing resolver degrades to unknown, never throws
      setMetadataProviderResolver(() => {
        throw new Error('store down')
      })
      expect(resolveProviderForMetadata(makeModel('m', 'a'))).toBeNull()
    } finally {
      setMetadataProviderResolver(null)
    }
  })
})

describe('modelMetadata status subscription — stable useSyncExternalStore source', () => {
  it('starts loading with a stable reference and notifies on transitions', () => {
    setModelMetadataSnapshotForTests(null)
    const first = getModelMetadataStatusSnapshot()
    expect(first).toEqual({ kind: 'loading', snapshot: null })

    const seen: string[] = []
    const unsubscribe = subscribeModelMetadataStatus(() => {
      seen.push(getModelMetadataStatusSnapshot().kind)
    })
    try {
      // installing a snapshot transitions to ready with one notification
      setModelMetadataSnapshotForTests(SNAPSHOT)
      expect(seen).toEqual(['ready'])
      // the reference is stable until the next transition (no fresh objects)
      expect(getModelMetadataStatusSnapshot()).toBe(getModelMetadataStatus())
      const readyRef = getModelMetadataStatusSnapshot()
      expect(getModelMetadataStatusSnapshot()).toBe(readyRef)
      // clearing back transitions to loading with one notification
      setModelMetadataSnapshotForTests(null)
      expect(seen).toEqual(['ready', 'loading'])
    } finally {
      unsubscribe()
      setModelMetadataSnapshotForTests(null)
    }
  })

  it('stops notifying after unsubscribe', () => {
    setModelMetadataSnapshotForTests(null)
    const listener = vi.fn()
    const unsubscribe = subscribeModelMetadataStatus(listener)
    unsubscribe()
    setModelMetadataSnapshotForTests(SNAPSHOT)
    expect(listener).not.toHaveBeenCalled()
    setModelMetadataSnapshotForTests(null)
  })

  it('adopts a Main-reported unavailable status with its sanitized reason', async () => {
    const getSnapshot = vi.fn().mockResolvedValue(null)
    const getStatus = vi.fn().mockResolvedValue({ kind: 'unavailable', snapshot: null, reason: 'timeout' })
    ;(window as any).api = { ...(window as any).api, modelMetadata: { getSnapshot, getStatus } }
    try {
      setModelMetadataSnapshotForTests(null)
      await expect(initModelMetadataRegistry()).resolves.toBeNull()
      expect(getModelMetadataStatus()).toEqual({ kind: 'unavailable', snapshot: null, reason: 'timeout' })
    } finally {
      delete (window as any).api.modelMetadata
      setModelMetadataSnapshotForTests(null)
    }
  })

  it('stays loading (never unavailable) while Main reports a round in flight', async () => {
    const getSnapshot = vi.fn().mockResolvedValue(null)
    const getStatus = vi.fn().mockResolvedValue({ kind: 'loading', snapshot: null })
    ;(window as any).api = { ...(window as any).api, modelMetadata: { getSnapshot, getStatus } }
    try {
      setModelMetadataSnapshotForTests(null)
      await expect(initModelMetadataRegistry()).resolves.toBeNull()
      expect(getModelMetadataStatus()).toEqual({ kind: 'loading', snapshot: null })
    } finally {
      delete (window as any).api.modelMetadata
      setModelMetadataSnapshotForTests(null)
    }
  })

  it('marks completed IPC failures unavailable with a sanitized reason', async () => {
    // compat surface (no getStatus): a throwing read is a completed failure
    const failing = vi.fn().mockRejectedValue(new Error('ipc down'))
    ;(window as any).api = { ...(window as any).api, modelMetadata: { getSnapshot: failing } }
    try {
      setModelMetadataSnapshotForTests(null)
      await expect(initModelMetadataRegistry()).resolves.toBeNull()
      expect(getModelMetadataStatus()).toEqual({ kind: 'unavailable', snapshot: null, reason: 'network-error' })
    } finally {
      delete (window as any).api.modelMetadata
      setModelMetadataSnapshotForTests(null)
    }
  })

  it('keeps an existing snapshot ready across a failed refresh', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('ipc down'))
    ;(window as any).api = { ...(window as any).api, modelMetadata: { refresh } }
    try {
      setModelMetadataSnapshotForTests(SNAPSHOT)
      await expect(refreshModelMetadataRegistry()).resolves.toEqual(SNAPSHOT)
      expect(getModelMetadataStatus().kind).toBe('ready')
      expect(getModelMetadataStatus().snapshot).toEqual(SNAPSHOT)
    } finally {
      delete (window as any).api.modelMetadata
      setModelMetadataSnapshotForTests(null)
    }
  })

  it('notifies subscribers when the async init round completes', async () => {
    const getSnapshot = vi.fn().mockResolvedValue(SNAPSHOT)
    ;(window as any).api = { ...(window as any).api, modelMetadata: { getSnapshot } }
    try {
      setModelMetadataSnapshotForTests(null)
      const kinds: string[] = []
      const unsubscribe = subscribeModelMetadataStatus(() => {
        kinds.push(getModelMetadataStatusSnapshot().kind)
      })
      try {
        expect(getModelMetadataStatus().kind).toBe('loading')
        await expect(initModelMetadataRegistry()).resolves.toEqual(SNAPSHOT)
        expect(kinds[kinds.length - 1]).toBe('ready')
      } finally {
        unsubscribe()
      }
    } finally {
      delete (window as any).api.modelMetadata
      setModelMetadataSnapshotForTests(null)
    }
  })

  it('exposes an explicit test-only status seam', () => {
    setModelMetadataStatusForTests({ kind: 'unavailable', snapshot: null, reason: 'http-error' })
    try {
      expect(getModelMetadataStatus()).toEqual({ kind: 'unavailable', snapshot: null, reason: 'http-error' })
    } finally {
      setModelMetadataSnapshotForTests(null)
    }
  })
})

describe('initModelMetadataRegistry — boot never blocks', () => {
  it('resolves null when the preload surface is absent and never throws', async () => {
    setModelMetadataSnapshotForTests(null)
    // jsdom test env has no window.api.modelMetadata surface
    expect((window as any).api?.modelMetadata).toBeUndefined()
    await expect(initModelMetadataRegistry()).resolves.toBeNull()
  })

  it('stores a well-shaped snapshot in memory only', async () => {
    const getSnapshot = vi.fn().mockResolvedValue(SNAPSHOT)
    ;(window as any).api = { ...(window as any).api, modelMetadata: { getSnapshot } }
    try {
      setModelMetadataSnapshotForTests(null)
      await expect(initModelMetadataRegistry()).resolves.toEqual(SNAPSHOT)
      expect(lookupModelMetadata('anthropic', 'claude-sonnet-4-6')?.id).toBe('claude-sonnet-4-6')
    } finally {
      delete (window as any).api.modelMetadata
      setModelMetadataSnapshotForTests(null)
    }
  })

  it('treats IPC failures and malformed payloads as unknown without throwing', async () => {
    const getSnapshot = vi.fn().mockRejectedValue(new Error('ipc down'))
    ;(window as any).api = { ...(window as any).api, modelMetadata: { getSnapshot } }
    try {
      setModelMetadataSnapshotForTests(null)
      await expect(initModelMetadataRegistry()).resolves.toBeNull()
      expect(lookupModelMetadata('anthropic', 'claude-sonnet-4-6')).toBeUndefined()
    } finally {
      delete (window as any).api.modelMetadata
      setModelMetadataSnapshotForTests(null)
    }
  })

  it.each([
    ['missing providers', { source: 'models.dev', fetchedAt: 1 }],
    ['wrong source', { source: 'evil', fetchedAt: 1, providers: {} }],
    ['array', []],
    ['string', 'nope'],
    ['null', null],
    ['number', 42]
  ])('validates IPC data with the shared schema (malformed %s -> null)', async (_label, payload) => {
    const getSnapshot = vi.fn().mockResolvedValue(payload)
    ;(window as any).api = { ...(window as any).api, modelMetadata: { getSnapshot } }
    try {
      setModelMetadataSnapshotForTests(null)
      await expect(initModelMetadataRegistry()).resolves.toBeNull()
      expect(lookupModelMetadata('anthropic', 'claude-sonnet-4-6')).toBeUndefined()
    } finally {
      delete (window as any).api.modelMetadata
      setModelMetadataSnapshotForTests(null)
    }
  })
})
