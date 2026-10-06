/**
 * ensure-assistant-topics contract — strict request exact-keys + result shape.
 */

import { describe, expect, it } from 'vitest'

import { validateChatDbRequest, validateChatDbResult } from '../contracts'

const CHANNEL = 'chatdb:ensure-assistant-topics' as never

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

describe('ensure-assistant-topics contract', () => {
  it('accepts minimal + full requests', () => {
    expect(() => validateChatDbRequest(CHANNEL, { assistantId: 'a-1', candidateTopicId: 't-1' })).not.toThrow()
    expect(() =>
      validateChatDbRequest(CHANNEL, { assistantId: 'a-1', candidateTopicId: 't-1', candidateName: 'Default' })
    ).not.toThrow()
    expect(() =>
      validateChatDbRequest(CHANNEL, { assistantId: 'a-1', candidateTopicId: 't-1', candidateName: null })
    ).not.toThrow()
  })

  it('rejects invalid args and unknown keys (fail-closed)', () => {
    expect(() => validateChatDbRequest(CHANNEL, { assistantId: '', candidateTopicId: 't-1' })).toThrow()
    expect(() => validateChatDbRequest(CHANNEL, { assistantId: 'a-1', candidateTopicId: '' })).toThrow()
    expect(() =>
      validateChatDbRequest(CHANNEL, { assistantId: 'a-1', candidateTopicId: 't-1', candidateName: '' })
    ).toThrow()
    expect(() => validateChatDbRequest(CHANNEL, { assistantId: 'a-1', candidateTopicId: 't-1', extra: 1 })).toThrow()
    expect(() => validateChatDbRequest(CHANNEL, { assistantId: 'a-1' })).toThrow()
  })

  it('accepts a valid result envelope', () => {
    expect(() => validateChatDbResult(CHANNEL, okResult({ topics: [wire('t-1')], created: true }))).not.toThrow()
    expect(() =>
      validateChatDbResult(CHANNEL, okResult({ topics: [wire('t-1'), wire('t-2')], created: false }))
    ).not.toThrow()
  })

  it('rejects mismatched/empty/duplicate results', () => {
    expect(() => validateChatDbResult(CHANNEL, okResult({ topics: [], created: false }))).toThrow()
    expect(() => validateChatDbResult(CHANNEL, okResult({ topics: [wire('t-1')] }))).toThrow()
    expect(() =>
      validateChatDbResult(CHANNEL, okResult({ topics: [wire('t-1'), wire('t-1')], created: false }))
    ).toThrow()
    expect(() => validateChatDbResult(CHANNEL, okResult({ topics: [wire('t-1')], created: false, extra: 1 }))).toThrow()
  })
})
