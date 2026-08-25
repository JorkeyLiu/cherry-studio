import { describe, expect, it } from 'vitest'

import { validateTopicDeletionEvent } from '../validation'

describe('TopicDeletionEvent validation', () => {
  it('accepts valid payload with single id', () => {
    expect(() => validateTopicDeletionEvent({ deletedTopicIds: ['t-1'] })).not.toThrow()
  })
  it('accepts valid payload with multiple ids', () => {
    expect(() => validateTopicDeletionEvent({ deletedTopicIds: ['t-1', 't-2'] })).not.toThrow()
  })
  it('accepts empty array', () => {
    expect(() => validateTopicDeletionEvent({ deletedTopicIds: [] })).not.toThrow()
  })
  it('rejects unknown keys', () => {
    expect(() => validateTopicDeletionEvent({ deletedTopicIds: ['t-1'], extra: 1 } as unknown)).toThrow()
  })
  it('rejects missing deletedTopicIds', () => {
    expect(() => validateTopicDeletionEvent({} as unknown)).toThrow()
  })
  it('rejects non-array deletedTopicIds', () => {
    expect(() => validateTopicDeletionEvent({ deletedTopicIds: 't-1' } as unknown)).toThrow()
  })
  it('rejects array with empty string', () => {
    expect(() => validateTopicDeletionEvent({ deletedTopicIds: [''] } as unknown)).toThrow()
  })
  it('rejects non-plain object', () => {
    expect(() => validateTopicDeletionEvent(null as unknown)).toThrow()
    expect(() => validateTopicDeletionEvent([] as unknown)).toThrow()
  })
  it('rejects sparse or non-JSON-safe values via json validation', () => {
    const payload: unknown = { deletedTopicIds: ['t-1'] }
    // inject undefined would be caught by validateJsonValue
    ;(payload as Record<string, unknown>).deletedTopicIds = ['t-1', undefined as unknown as string]
    expect(() => validateTopicDeletionEvent(payload)).toThrow()
  })
})
