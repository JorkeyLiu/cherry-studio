import { describe, expect, it } from 'vitest'

import {
  applyTopicSyncDefaults,
  filterBlockPayload,
  filterMessagePayload,
  filterTopicPayload,
  isPayloadSafe,
  TOPIC_SYNC_DEFAULTS,
  validateSyncPayloadAllowlist
} from '../payloadFilter'
import { SYNC_MESSAGE_PATCH_FIELDS } from '../types'

describe('sync payload filter', () => {
  it('filters topic allowlist and strips file_path', () => {
    const raw: Record<string, unknown> = {
      id: 't1',
      name: 'Hello',
      assistantId: 'a1',
      extra: 'should be stripped',
      file_path: '/secret',
      filePath: '/secret2',
      credentials: 'no'
    }
    const out = filterTopicPayload(raw)!
    expect(out).toEqual({ id: 't1', name: 'Hello', assistantId: 'a1' })
    expect('file_path' in out).toBe(false)
  })

  it('filters message allowlist', () => {
    const raw: Record<string, unknown> = {
      id: 'm1',
      topicId: 't1',
      role: 'user',
      content: 'hi',
      fts: 'should be gone',
      contextWindowAnchor: 'x',
      file_path: '/x'
    }
    const out = filterMessagePayload(raw)!
    expect(out).toEqual({ id: 'm1', topicId: 't1', role: 'user', content: 'hi' })
  })

  it('filters block allowlist and excludes file_path', () => {
    const raw: Record<string, unknown> = {
      id: 'b1',
      messageId: 'm1',
      type: 'image',
      content: 'img',
      filePath: '/tmp/a.png',
      file_path: '/tmp/b.png',
      extra: { file: { id: 'f1', path: '/tmp' } }
    }
    const out = filterBlockPayload(raw)!
    expect(out).toEqual({ id: 'b1', messageId: 'm1', type: 'image', content: 'img' })
  })

  it('isPayloadSafe rejects credentials nested', () => {
    expect(isPayloadSafe({ token: 'secret' })).toBe(true) // token alone is not flagged? but credentials should
    expect(isPayloadSafe({ credentials: 'x' })).toBe(false)
    expect(isPayloadSafe({ nested: { password: 'x' } })).toBe(false)
  })

  it('validateSyncPayloadAllowlist rejects non-allowlisted field', () => {
    const err = validateSyncPayloadAllowlist({
      entityType: 'topic',
      payload: { id: 't1', name: 'n', rogue: 'x' } as any
    })
    expect(err).toContain('not allowlisted')
  })

  it('validateSyncPayloadAllowlist rejects contextWindowAnchor', () => {
    const err = validateSyncPayloadAllowlist({
      entityType: 'message',
      payload: { id: 'm1', contextWindowAnchor: 'x' } as any
    })
    expect(err).toContain('contextWindowAnchor')
  })

  it('foldSelected stays device-local: filtered from message payload and rejected by the allowlist', () => {
    const out = filterMessagePayload({
      id: 'm1',
      topicId: 't1',
      role: 'assistant',
      content: 'hi',
      foldSelected: true
    } as unknown as Record<string, unknown>)!
    expect('foldSelected' in out).toBe(false)
    const err = validateSyncPayloadAllowlist({
      entityType: 'message',
      payload: { id: 'm1', topicId: 't1', foldSelected: true } as never
    })
    expect(err).toContain('not allowlisted')
    expect((SYNC_MESSAGE_PATCH_FIELDS as readonly string[]).includes('foldSelected')).toBe(false)
  })
})

describe('topic canonical sync defaults', () => {
  it('exposes the single shared default triple', () => {
    expect({ ...TOPIC_SYNC_DEFAULTS }).toEqual({
      pinned: false,
      prompt: null,
      isNameManuallyEdited: false
    })
  })

  it('materializes absent defaults for a sparse topic payload', () => {
    const payload: Record<string, unknown> = {
      id: 't1',
      name: 'T',
      assistantId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      deletedAt: null
    }
    const out = applyTopicSyncDefaults(payload)
    expect(out.pinned).toBe(false)
    expect(out.prompt).toBeNull()
    expect(out.isNameManuallyEdited).toBe(false)
    expect(Object.keys(out).sort()).toEqual(
      [
        'assistantId',
        'createdAt',
        'deletedAt',
        'id',
        'isNameManuallyEdited',
        'name',
        'pinned',
        'prompt',
        'updatedAt'
      ].sort()
    )
  })

  it('preserves explicit values including explicit null and never overwrites', () => {
    const payload: Record<string, unknown> = {
      id: 't1',
      name: 'T',
      assistantId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      deletedAt: null,
      pinned: true,
      prompt: null,
      isNameManuallyEdited: true
    }
    const out = applyTopicSyncDefaults({ ...payload })
    expect(out.pinned).toBe(true)
    expect(out.prompt).toBeNull()
    expect(out.isNameManuallyEdited).toBe(true)
  })

  it('treats undefined as absent but keeps explicit false/null', () => {
    const out = applyTopicSyncDefaults({
      id: 't1',
      pinned: undefined,
      prompt: 'keep',
      isNameManuallyEdited: false
    })
    expect(out.pinned).toBe(false)
    expect(out.prompt).toBe('keep')
    expect(out.isNameManuallyEdited).toBe(false)
  })
})
