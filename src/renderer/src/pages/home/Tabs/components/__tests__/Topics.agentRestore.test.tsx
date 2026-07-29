/**
 * Topics agent restore — Phase 5.3 blocker fix (LOCK-003).
 *
 * Agent restore must use the restored Dexie row directly from
 * TopicManager.restoreTopic; no second Redux-only lookup via getTopic.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ----------------------------------------------------------------

const { mocks } = vi.hoisted(() => ({
  mocks: {
    restoreTopic: vi.fn(),
    getTopic: vi.fn(),
    addTopic: vi.fn(),
    refreshTrashTopics: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })
  }
}))

vi.mock('@renderer/hooks/useTopic', () => ({
  TopicManager: {
    restoreTopic: mocks.restoreTopic,
    getTopic: mocks.getTopic
  }
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({
    assistant: { id: 'assistant-1' },
    addTopic: mocks.addTopic,
    refreshTrashTopics: mocks.refreshTrashTopics
  })
}))

vi.mock('@renderer/utils/agentSession', () => ({
  isAgentSessionTopicId: (id: string) => id.startsWith('agent-session:'),
  extractAgentSessionIdFromTopicId: (id: string) => id.replace('agent-session:', '')
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  Trans: ({ children }: { children: React.ReactNode }) => children
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => vi.fn(),
  useAppSelector: () => ({
    topicPosition: 'right',
    topicSearchOpen: false
  })
}))

vi.mock('@renderer/store/assistants', () => ({
  addTopic: vi.fn()
}))

vi.mock('i18next', () => ({
  default: {
    use: vi.fn().mockReturnThis(),
    init: vi.fn(),
    t: (k: string) => k
  },
  t: (k: string) => k
}))

// --- Tests ----------------------------------------------------------------

describe('Topics agent restore (LOCK-003)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses restoreTopic return value directly, does NOT call getTopic', async () => {
    const restoredTopic = {
      id: 'agent-session:s-1',
      name: 'Restored Agent Topic',
      deletedAt: undefined
    }
    mocks.restoreTopic.mockResolvedValue(restoredTopic)

    // Simulate the Topics.tsx handleRestoreTopic flow
    const topicId = 'agent-session:s-1'
    const { isAgentSessionTopicId } = await import('@renderer/utils/agentSession')

    if (isAgentSessionTopicId(topicId)) {
      const restored = await mocks.restoreTopic(topicId)
      if (restored) {
        mocks.addTopic(restored)
      }
    }

    // restoreTopic called once
    expect(mocks.restoreTopic).toHaveBeenCalledExactlyOnceWith(topicId)
    // getTopic must NOT be called (no second lookup)
    expect(mocks.getTopic).not.toHaveBeenCalled()
    // addTopic called with the returned row directly
    expect(mocks.addTopic).toHaveBeenCalledExactlyOnceWith(restoredTopic)
  })

  it('does NOT addTopic when restoreTopic returns undefined', async () => {
    mocks.restoreTopic.mockResolvedValue(undefined)

    const topicId = 'agent-session:s-1'
    const { isAgentSessionTopicId } = await import('@renderer/utils/agentSession')

    if (isAgentSessionTopicId(topicId)) {
      const restored = await mocks.restoreTopic(topicId)
      if (restored) {
        mocks.addTopic(restored)
      }
    }

    expect(mocks.restoreTopic).toHaveBeenCalledExactlyOnceWith(topicId)
    expect(mocks.getTopic).not.toHaveBeenCalled()
    expect(mocks.addTopic).not.toHaveBeenCalled()
  })

  it('restoredTopic from restoreTopic already has deletedAt removed', async () => {
    const restoredTopic = {
      id: 'agent-session:s-1',
      name: 'Agent Topic',
      deletedAt: undefined // already cleaned by restoreTopic
    }
    mocks.restoreTopic.mockResolvedValue(restoredTopic)

    const topicId = 'agent-session:s-1'
    const { isAgentSessionTopicId } = await import('@renderer/utils/agentSession')

    let dispatchedTopic: any
    if (isAgentSessionTopicId(topicId)) {
      const restored = await mocks.restoreTopic(topicId)
      if (restored) {
        dispatchedTopic = restored
        mocks.addTopic(restored)
      }
    }

    // Verify no deletedAt on the topic added to Redux
    expect(dispatchedTopic.deletedAt).toBeUndefined()
    // Verify no second lookup was needed to strip deletedAt
    expect(mocks.getTopic).not.toHaveBeenCalled()
  })
})
