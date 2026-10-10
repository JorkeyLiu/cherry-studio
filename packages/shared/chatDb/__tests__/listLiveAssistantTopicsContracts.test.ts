/**
 * list-live-assistant-topics contract + chat-projection invalidation event —
 * strict request exact-keys, read-only result shape (empty allowed, never
 * resurrected here), and closed-set hint validation.
 */

import { describe, expect, it } from 'vitest'

import { validateChatDbRequest, validateChatDbResult } from '../contracts'
import { validateChatProjectionInvalidationEvent } from '../validation'

const CHANNEL = 'chatdb:list-live-assistant-topics' as never

function okResult(value: unknown): unknown {
  return { ok: true, value }
}

function wire(id: string): Record<string, unknown> {
  return {
    id,
    assistantId: 'a-1',
    name: 'T',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('list-live-assistant-topics contract', () => {
  it('accepts the minimal request', () => {
    expect(() => validateChatDbRequest(CHANNEL, { assistantId: 'a-1' })).not.toThrow()
  })

  it('rejects invalid args and unknown keys (fail-closed)', () => {
    expect(() => validateChatDbRequest(CHANNEL, { assistantId: '' })).toThrow()
    expect(() => validateChatDbRequest(CHANNEL, { assistantId: 'a-1', extra: 1 })).toThrow()
    expect(() => validateChatDbRequest(CHANNEL, {})).toThrow()
  })

  it('accepts a valid result envelope, including authoritative empty', () => {
    expect(() =>
      validateChatDbResult(CHANNEL, okResult({ assistantId: 'a-1', topics: [wire('t-1'), wire('t-2')] }))
    ).not.toThrow()
    // Empty is a valid authoritative answer (never resurrected on this path).
    expect(() => validateChatDbResult(CHANNEL, okResult({ assistantId: 'a-1', topics: [] }))).not.toThrow()
  })

  it('rejects mismatched/duplicate/unknown-key results', () => {
    expect(() => validateChatDbResult(CHANNEL, okResult({ assistantId: '', topics: [] }))).toThrow()
    expect(() => validateChatDbResult(CHANNEL, okResult({ assistantId: 'a-1' }))).toThrow()
    expect(() =>
      validateChatDbResult(CHANNEL, okResult({ assistantId: 'a-1', topics: [wire('t-1'), wire('t-1')] }))
    ).toThrow()
    expect(() => validateChatDbResult(CHANNEL, okResult({ assistantId: 'a-1', topics: [], created: false }))).toThrow()
  })

  it('rejects cross-assistant rows and malformed assistant bindings (pure collection)', () => {
    // Foreign-assistant row must not cross-link: whole result rejects.
    expect(() =>
      validateChatDbResult(
        CHANNEL,
        okResult({ assistantId: 'a-1', topics: [wire('t-1'), { ...wire('t-2'), assistantId: 'a-2' }] })
      )
    ).toThrow()
    // Missing assistantId (legacy optional shape) rejects rather than merging.
    const { assistantId: _omit, ...noAssistant } = wire('t-1')
    expect(() => validateChatDbResult(CHANNEL, okResult({ assistantId: 'a-1', topics: [noAssistant] }))).toThrow()
    // Null/empty assistantId rejects.
    expect(() =>
      validateChatDbResult(CHANNEL, okResult({ assistantId: 'a-1', topics: [{ ...wire('t-1'), assistantId: null }] }))
    ).toThrow()
    expect(() =>
      validateChatDbResult(CHANNEL, okResult({ assistantId: 'a-1', topics: [{ ...wire('t-1'), assistantId: '' }] }))
    ).toThrow()
  })
})

describe('chat-projection invalidation event', () => {
  it('accepts precise and coarse hints', () => {
    expect(() =>
      validateChatProjectionInvalidationEvent({
        assistantIds: ['a-1'],
        topicIds: ['t-1', 't-2'],
        branchIds: ['b-1'],
        reason: 'sync-incremental'
      })
    ).not.toThrow()
    expect(() =>
      validateChatProjectionInvalidationEvent({
        assistantIds: ['a-1', 'a-2'],
        topicIds: [],
        branchIds: [],
        reason: 'sync-baseline'
      })
    ).not.toThrow()
    expect(() =>
      validateChatProjectionInvalidationEvent({
        assistantIds: ['a-1'],
        topicIds: ['t-1'],
        branchIds: [],
        reason: 'local-commit'
      })
    ).not.toThrow()
  })

  it('rejects unscoped/unknown-key/malformed hints (fail-closed)', () => {
    expect(() =>
      validateChatProjectionInvalidationEvent({
        assistantIds: [],
        topicIds: ['t-1'],
        branchIds: [],
        reason: 'sync-incremental'
      })
    ).toThrow()
    expect(() =>
      validateChatProjectionInvalidationEvent({
        assistantIds: ['a-1'],
        topicIds: ['t-1'],
        branchIds: [],
        reason: 'sync-incremental',
        extra: 1
      } as unknown)
    ).toThrow()
    expect(() =>
      validateChatProjectionInvalidationEvent({
        assistantIds: ['a-1'],
        topicIds: 't-1',
        branchIds: [],
        reason: 'sync-incremental'
      } as unknown)
    ).toThrow()
    expect(() =>
      validateChatProjectionInvalidationEvent({
        assistantIds: ['a-1'],
        topicIds: [''],
        branchIds: [],
        reason: 'sync-incremental'
      })
    ).toThrow()
    expect(() =>
      validateChatProjectionInvalidationEvent({
        assistantIds: ['a-1'],
        topicIds: [],
        branchIds: [],
        reason: 'network-hint'
      } as unknown)
    ).toThrow()
    expect(() => validateChatProjectionInvalidationEvent(null as unknown)).toThrow()
    expect(() => validateChatProjectionInvalidationEvent([] as unknown)).toThrow()
  })
})
