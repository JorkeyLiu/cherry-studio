import type { Topic } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TopicDeletionFlowDeps } from '../topicDeletionFlow'
import { deleteTopicFlow } from '../topicDeletionFlow'

// --- Fixtures -------------------------------------------------------------

function makeTopic(id: string): Topic {
  return {
    id,
    assistantId: 'a-1',
    name: `Topic ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: []
  } as Topic
}

function makeDeps(overrides: Partial<TopicDeletionFlowDeps> = {}): TopicDeletionFlowDeps {
  return {
    modelGenerating: vi.fn().mockResolvedValue(undefined),
    removeTopic: vi.fn().mockResolvedValue(undefined),
    addTopic: vi.fn(),
    setActiveTopic: vi.fn(),
    createPersistedReplacement: vi.fn().mockResolvedValue(makeTopic('t-replacement')),
    ...overrides
  }
}

// --- Tests ----------------------------------------------------------------

describe('deleteTopicFlow (Phase 5.2B, LOCK-528)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('soft delete persists BEFORE the active topic switches', async () => {
    const order: string[] = []
    const deps = makeDeps({
      removeTopic: vi.fn().mockImplementation(async () => {
        order.push('delete')
      }),
      setActiveTopic: vi.fn().mockImplementation(() => {
        order.push('switch')
      })
    })
    const topics = [makeTopic('t-1'), makeTopic('t-2')]

    await deleteTopicFlow({ topic: topics[0], topics, activeTopicId: 't-1', deps })

    expect(order).toEqual(['delete', 'switch'])
    expect(deps.setActiveTopic).toHaveBeenCalledWith(topics[1])
    expect(deps.addTopic).not.toHaveBeenCalled()
    expect(deps.createPersistedReplacement).not.toHaveBeenCalled()
  })

  it('a FAILED soft delete neither switches the active topic nor creates a UI topic', async () => {
    const deps = makeDeps({
      removeTopic: vi.fn().mockRejectedValue(new Error('SQLITE_FAILURE'))
    })
    const topics = [makeTopic('t-1'), makeTopic('t-2')]

    await expect(deleteTopicFlow({ topic: topics[0], topics, activeTopicId: 't-1', deps })).rejects.toThrow(
      'SQLITE_FAILURE'
    )

    expect(deps.setActiveTopic).not.toHaveBeenCalled()
    expect(deps.addTopic).not.toHaveBeenCalled()
  })

  it('does not switch the active topic when a non-active topic is deleted', async () => {
    const deps = makeDeps()
    const topics = [makeTopic('t-1'), makeTopic('t-2')]

    await deleteTopicFlow({ topic: topics[1], topics, activeTopicId: 't-1', deps })

    expect(deps.removeTopic).toHaveBeenCalledExactlyOnceWith(topics[1])
    expect(deps.setActiveTopic).not.toHaveBeenCalled()
    expect(deps.addTopic).not.toHaveBeenCalled()
  })

  it('last topic: persists the replacement first, exposes it only after the delete succeeded', async () => {
    const order: string[] = []
    const replacement = makeTopic('t-replacement')
    const deps = makeDeps({
      createPersistedReplacement: vi.fn().mockImplementation(async () => {
        order.push('persist-replacement')
        return replacement
      }),
      removeTopic: vi.fn().mockImplementation(async () => {
        order.push('delete')
      }),
      addTopic: vi.fn().mockImplementation(() => {
        order.push('expose-replacement')
      }),
      setActiveTopic: vi.fn().mockImplementation(() => {
        order.push('switch')
      })
    })
    const topics = [makeTopic('t-only')]

    await deleteTopicFlow({ topic: topics[0], topics, activeTopicId: 't-only', deps })

    expect(order).toEqual(['persist-replacement', 'delete', 'expose-replacement', 'switch'])
    expect(deps.addTopic).toHaveBeenCalledWith(replacement)
    expect(deps.setActiveTopic).toHaveBeenCalledWith(replacement)
  })

  it('last topic: a FAILED delete keeps the replacement out of the UI', async () => {
    const deps = makeDeps({
      removeTopic: vi.fn().mockRejectedValue(new Error('SQLITE_FAILURE'))
    })
    const topics = [makeTopic('t-only')]

    await expect(deleteTopicFlow({ topic: topics[0], topics, activeTopicId: 't-only', deps })).rejects.toThrow(
      'SQLITE_FAILURE'
    )

    // The replacement may be persisted, but it is never exposed to Redux
    // or made active (LOCK-528).
    expect(deps.addTopic).not.toHaveBeenCalled()
    expect(deps.setActiveTopic).not.toHaveBeenCalled()
  })

  it('a failed replacement persistence aborts before the destructive delete (LOCK-533)', async () => {
    const deps = makeDeps({
      createPersistedReplacement: vi.fn().mockRejectedValue(new Error('SQLITE_FAILURE'))
    })
    const topics = [makeTopic('t-only')]

    await expect(deleteTopicFlow({ topic: topics[0], topics, activeTopicId: 't-only', deps })).rejects.toThrow(
      'SQLITE_FAILURE'
    )

    expect(deps.removeTopic).not.toHaveBeenCalled()
    expect(deps.addTopic).not.toHaveBeenCalled()
    expect(deps.setActiveTopic).not.toHaveBeenCalled()
  })

  it('waits for in-flight generation before deleting', async () => {
    const order: string[] = []
    const deps = makeDeps({
      modelGenerating: vi.fn().mockImplementation(async () => {
        order.push('generation-settled')
      }),
      removeTopic: vi.fn().mockImplementation(async () => {
        order.push('delete')
      })
    })
    const topics = [makeTopic('t-1'), makeTopic('t-2')]

    await deleteTopicFlow({ topic: topics[0], topics, activeTopicId: 't-2', deps })

    expect(order).toEqual(['generation-settled', 'delete'])
  })
})
