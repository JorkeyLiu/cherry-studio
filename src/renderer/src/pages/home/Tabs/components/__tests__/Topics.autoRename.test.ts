import type { Topic } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import { resolveManualAutoRenameProjection } from '../Topics'

function makeLatest(overrides: Partial<Topic> = {}): Topic {
  return {
    id: 'topic-1',
    assistantId: 'assistant-1',
    name: 'New Topic',
    pinned: false,
    prompt: '',
    isNameManuallyEdited: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [],
    ...overrides
  } as Topic
}

describe('resolveManualAutoRenameProjection (manual Auto Rename authoritative flag)', () => {
  it('projects name + false flag on authoritative success', () => {
    const latest = makeLatest({ pinned: true, prompt: 'keep-me', isNameManuallyEdited: false })
    const data = resolveManualAutoRenameProjection(
      { name: 'Summarized Name', isNameManuallyEdited: false },
      'Summarized Name',
      latest
    )
    expect(data).not.toBeNull()
    expect(data!.name).toBe('Summarized Name')
    expect(data!.isNameManuallyEdited).toBe(false)
    expect(data!.pinned).toBe(true)
    expect(data!.prompt).toBe('keep-me')
  })

  it('same-name collision (intervening manual rename to exactly summaryText) keeps manual flag: skips projection', () => {
    // Main atomically no-ops on preimage mismatch and returns the current wire
    // unchanged: name coincidentally equals summaryText but the authoritative
    // flag is still true. Caller must skip so Redux keeps isNameManuallyEdited:true.
    const latest = makeLatest({ name: 'Summarized Name', isNameManuallyEdited: true })
    const data = resolveManualAutoRenameProjection(
      { name: 'Summarized Name', isNameManuallyEdited: true },
      'Summarized Name',
      latest
    )
    expect(data).toBeNull()
    expect(latest.isNameManuallyEdited).toBe(true)
  })

  it('name mismatch (changed preimage) skips projection', () => {
    const latest = makeLatest()
    expect(
      resolveManualAutoRenameProjection(
        { name: 'My Manual Title', isNameManuallyEdited: true },
        'Stale Summary',
        latest
      )
    ).toBeNull()
  })

  it('missing returned flag (not requested false) skips projection', () => {
    const latest = makeLatest()
    expect(resolveManualAutoRenameProjection({ name: 'Summarized Name' }, 'Summarized Name', latest)).toBeNull()
    expect(
      resolveManualAutoRenameProjection(
        { name: 'Summarized Name', isNameManuallyEdited: null },
        'Summarized Name',
        latest
      )
    ).toBeNull()
  })
})
