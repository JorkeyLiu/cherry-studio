import type { Topic } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mocks ---------------------------------------------------------------

const { mockUpdateTopicMetadata } = vi.hoisted(() => ({ mockUpdateTopicMetadata: vi.fn() }))

vi.mock('@renderer/store', () => ({
  default: {
    getState: vi.fn()
  }
}))

vi.mock('@renderer/utils/agentSession', () => ({
  isAgentSessionTopicId: (id: string) => id.startsWith('agent-session:')
}))

vi.mock('../SqliteMessageDataSource', () => ({
  SqliteMessageDataSource: class {
    updateTopicMetadata = mockUpdateTopicMetadata
  }
}))

// A minimal structured-failure shape mirroring ChatDbResultError.
class MockChatDbResultError extends Error {
  code: string
  retryable: boolean
  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'ChatDbResultError'
    this.code = code
    this.retryable = retryable
  }
}

import store from '@renderer/store'

import { persistTopicMetadata } from '../topicMetadataPersist'

// --- Fixtures -------------------------------------------------------------

function makeTopic(overrides: Partial<Topic> = {}): Topic {
  return {
    id: 't-1',
    assistantId: 'a-1',
    name: 'Old Name',
    pinned: false,
    prompt: '',
    isNameManuallyEdited: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [],
    ...overrides
  } as Topic
}

function setPrevTopic(topic: Topic | undefined) {
  ;(store.getState as ReturnType<typeof vi.fn>).mockReturnValue({
    assistants: {
      assistants: topic ? [{ id: topic.assistantId, topics: [topic] }] : [{ id: 'a-1', topics: [] }]
    }
  })
}

// --- Tests ----------------------------------------------------------------

describe('persistTopicMetadata (Phase 5.2B)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps only changed metadata fields and calls SQLite before resolving', async () => {
    const prev = makeTopic()
    const next = makeTopic({ name: 'New Name', pinned: true })
    setPrevTopic(prev)
    mockUpdateTopicMetadata.mockResolvedValue(undefined)

    await persistTopicMetadata(next)

    expect(mockUpdateTopicMetadata).toHaveBeenCalledTimes(1)
    // LOCK-522: only name + pinned changed; prompt and isNameManuallyEdited omitted (undefined).
    expect(mockUpdateTopicMetadata).toHaveBeenCalledWith('t-1', 'New Name', true, undefined, undefined)
  })

  it('persists a changed prompt field (LOCK-522 four-field coverage)', async () => {
    const prev = makeTopic()
    const next = makeTopic({ prompt: 'You are a helpful assistant' })
    setPrevTopic(prev)
    mockUpdateTopicMetadata.mockResolvedValue(undefined)

    await persistTopicMetadata(next)

    expect(mockUpdateTopicMetadata).toHaveBeenCalledExactlyOnceWith(
      't-1',
      undefined,
      undefined,
      'You are a helpful assistant',
      undefined
    )
  })

  it('persists a changed isNameManuallyEdited field (manual rename marker)', async () => {
    const prev = makeTopic()
    const next = makeTopic({ name: 'Manual Name', isNameManuallyEdited: true })
    setPrevTopic(prev)
    mockUpdateTopicMetadata.mockResolvedValue(undefined)

    await persistTopicMetadata(next)

    expect(mockUpdateTopicMetadata).toHaveBeenCalledExactlyOnceWith('t-1', 'Manual Name', undefined, undefined, true)
  })

  it('persists all four allowed fields when all change together', async () => {
    const prev = makeTopic()
    const next = makeTopic({ name: 'N', pinned: true, prompt: 'P', isNameManuallyEdited: true })
    setPrevTopic(prev)
    mockUpdateTopicMetadata.mockResolvedValue(undefined)

    await persistTopicMetadata(next)

    expect(mockUpdateTopicMetadata).toHaveBeenCalledExactlyOnceWith('t-1', 'N', true, 'P', true)
  })

  it('is a no-op (no SQLite call) when no allowed metadata field changed', async () => {
    const prev = makeTopic()
    const next = makeTopic() // identical
    setPrevTopic(prev)

    await persistTopicMetadata(next)

    expect(mockUpdateTopicMetadata).not.toHaveBeenCalled()
  })

  it('propagates structured NOT_FOUND failure (ChatDbResultError)', async () => {
    const prev = makeTopic()
    const next = makeTopic({ name: 'New Name' })
    setPrevTopic(prev)
    mockUpdateTopicMetadata.mockRejectedValue(new MockChatDbResultError('NOT_FOUND', 'topic missing'))

    await expect(persistTopicMetadata(next)).rejects.toMatchObject({ code: 'NOT_FOUND', name: 'ChatDbResultError' })
    expect(mockUpdateTopicMetadata).toHaveBeenCalledTimes(1)
  })

  it('propagates transport failure unchanged', async () => {
    const prev = makeTopic()
    const next = makeTopic({ pinned: true })
    setPrevTopic(prev)
    const transportError = new Error('IPC channel closed')
    mockUpdateTopicMetadata.mockRejectedValue(transportError)

    await expect(persistTopicMetadata(next)).rejects.toBe(transportError)
  })

  it('bypasses SQLite for agent-session topic IDs (LOCK-521/529)', async () => {
    const agentTopic = makeTopic({ id: 'agent-session:abc-123' })
    setPrevTopic(agentTopic)

    await persistTopicMetadata(agentTopic)

    expect(mockUpdateTopicMetadata).not.toHaveBeenCalled()
  })
})
