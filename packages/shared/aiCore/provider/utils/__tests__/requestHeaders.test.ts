import { describe, expect, it } from 'vitest'

import {
  generateRequestSessionId,
  getHeaderValue,
  isOpenCodeGoEndpoint,
  OPENCODE_SESSION_HEADER,
  resolveOutboundRequestHeaders
} from '../requestHeaders'

const GO_HOST = 'https://opencode.ai/zen/go/v1'

describe('shared request-header policy (single policy location)', () => {
  it('matches only the official HTTPS Go endpoint', () => {
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/go/v1')).toBe(true)
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/go')).toBe(true)
    expect(isOpenCodeGoEndpoint('HTTPS://OPENCODE.AI/ZEN/GO/V1')).toBe(true)
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/go/v1/responses#')).toBe(true)
    expect(isOpenCodeGoEndpoint('https://opencode.ai/zen/v1')).toBe(false)
    expect(isOpenCodeGoEndpoint('https://api.deepseek.com/v1')).toBe(false)
    expect(isOpenCodeGoEndpoint('https://opencode.ai.evil.com/zen/go/v1')).toBe(false)
    expect(isOpenCodeGoEndpoint('http://opencode.ai/zen/go/v1')).toBe(false)
    expect(isOpenCodeGoEndpoint(undefined)).toBe(false)
    expect(isOpenCodeGoEndpoint('')).toBe(false)
  })

  it('uses the stable topic identity for topic-scoped calls', () => {
    const first = resolveOutboundRequestHeaders({ apiHost: GO_HOST, topicId: 'topic-123' })
    const second = resolveOutboundRequestHeaders({ apiHost: GO_HOST, topicId: 'topic-123' })
    expect(first?.[OPENCODE_SESSION_HEADER]).toBe('topic-123')
    expect(second?.[OPENCODE_SESSION_HEADER]).toBe('topic-123')
  })

  it('mints one request-local opaque identity for genuinely topicless calls', () => {
    const headers = resolveOutboundRequestHeaders({ apiHost: GO_HOST, generateId: () => 'opaque-req-1' })
    expect(headers?.[OPENCODE_SESSION_HEADER]).toBe('opaque-req-1')
    const blank = resolveOutboundRequestHeaders({ apiHost: GO_HOST, topicId: '   ', generateId: () => 'opaque-req-2' })
    expect(blank?.[OPENCODE_SESSION_HEADER]).toBe('opaque-req-2')
  })

  it('generates an opaque default identity without user/model content', () => {
    const headers = resolveOutboundRequestHeaders({ apiHost: GO_HOST })
    const value = headers?.[OPENCODE_SESSION_HEADER] ?? ''
    expect(value).toBeTruthy()
    expect(generateRequestSessionId()).toBeTruthy()
    expect(getHeaderValue(headers, OPENCODE_SESSION_HEADER)).toBe(value)
    expect(getHeaderValue(headers, 'X-OPENCODE-SESSION')).toBe(value)
  })

  it('sends nothing on non-Go hosts', () => {
    expect(resolveOutboundRequestHeaders({ apiHost: 'https://opencode.ai/zen/v1', topicId: 't1' })).toBeUndefined()
    expect(resolveOutboundRequestHeaders({ apiHost: 'https://api.deepseek.com/v1', topicId: 't1' })).toBeUndefined()
    expect(resolveOutboundRequestHeaders({ apiHost: undefined, topicId: 't1' })).toBeUndefined()
  })

  it('lets an explicit caller header win case-insensitively without duplication', () => {
    const explicit = resolveOutboundRequestHeaders({
      apiHost: GO_HOST,
      topicId: 'topic-1',
      explicitHeaders: { [OPENCODE_SESSION_HEADER]: 'caller-value' }
    })
    expect(explicit?.[OPENCODE_SESSION_HEADER]).toBe('caller-value')

    const mixed = resolveOutboundRequestHeaders({
      apiHost: GO_HOST,
      topicId: 'topic-1',
      explicitHeaders: { 'X-OpenCode-Session': 'caller-mixed' }
    })
    expect(mixed?.['X-OpenCode-Session']).toBe('caller-mixed')
    expect(mixed?.[OPENCODE_SESSION_HEADER]).toBeUndefined()
  })

  it('lets provider extra session win over the automatic identity', () => {
    const viaProvider = resolveOutboundRequestHeaders({
      apiHost: GO_HOST,
      topicId: 'topic-1',
      providerExtraHeaders: { [OPENCODE_SESSION_HEADER]: 'provider-extra' }
    })
    expect(viaProvider?.[OPENCODE_SESSION_HEADER]).toBeUndefined()

    const explicitBeatsProvider = resolveOutboundRequestHeaders({
      apiHost: GO_HOST,
      topicId: 'topic-1',
      explicitHeaders: { 'X-OPENCODE-SESSION': 'caller-mixed' },
      providerExtraHeaders: { [OPENCODE_SESSION_HEADER]: 'provider-extra' }
    })
    expect(explicitBeatsProvider?.['X-OPENCODE-SESSION']).toBe('caller-mixed')
  })

  it('treats an undefined session value as absence so the automatic identity fills it', () => {
    const explicitUndefined = resolveOutboundRequestHeaders({
      apiHost: GO_HOST,
      topicId: 'topic-1',
      explicitHeaders: { [OPENCODE_SESSION_HEADER]: undefined, 'x-custom': 'keep' }
    })
    expect(explicitUndefined?.[OPENCODE_SESSION_HEADER]).toBe('topic-1')
    expect(explicitUndefined?.['x-custom']).toBe('keep')

    const topiclessUndefined = resolveOutboundRequestHeaders({
      apiHost: GO_HOST,
      explicitHeaders: { 'X-OpenCode-Session': undefined },
      generateId: () => 'opaque-undef-1'
    })
    expect(topiclessUndefined?.[OPENCODE_SESSION_HEADER]).toBe('opaque-undef-1')
    expect('X-OpenCode-Session' in (topiclessUndefined ?? {})).toBe(false)

    const providerUndefined = resolveOutboundRequestHeaders({
      apiHost: GO_HOST,
      topicId: 'topic-1',
      providerExtraHeaders: { [OPENCODE_SESSION_HEADER]: undefined }
    })
    expect(providerUndefined?.[OPENCODE_SESSION_HEADER]).toBe('topic-1')
  })

  it('preserves a defined empty explicit session value as-is (existing contract)', () => {
    const empty = resolveOutboundRequestHeaders({
      apiHost: GO_HOST,
      topicId: 'topic-1',
      explicitHeaders: { [OPENCODE_SESSION_HEADER]: '' }
    })
    expect(empty?.[OPENCODE_SESSION_HEADER]).toBe('')
  })
  it('merges non-conflicting explicit headers alongside the session header', () => {
    const merged = resolveOutboundRequestHeaders({
      apiHost: GO_HOST,
      topicId: undefined,
      explicitHeaders: { 'x-custom': 'keep' },
      generateId: () => 'opaque-1'
    })
    expect(merged?.[OPENCODE_SESSION_HEADER]).toBe('opaque-1')
    expect(merged?.['x-custom']).toBe('keep')
  })
})
