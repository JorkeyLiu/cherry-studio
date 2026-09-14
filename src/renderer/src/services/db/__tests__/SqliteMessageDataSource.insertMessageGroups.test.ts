import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

const { mocks } = vi.hoisted(() => ({
  mocks: {
    insertMessageGroups: vi.fn(),
    updateTopicUpdatedAt: vi.fn((p: unknown) => ({ type: 'assistants/updateTopicUpdatedAt', payload: p }))
  }
}))

vi.mock('@renderer/store', () => ({
  default: { dispatch: vi.fn(), getState: vi.fn() }
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: mocks.updateTopicUpdatedAt
}))

function successResult<T>(value: T) {
  return { ok: true as const, value }
}

describe('SqliteMessageDataSource.insertMessageGroups', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps to the named bridge with exact stable request and dispatches topic-updated once', async () => {
    mocks.insertMessageGroups.mockResolvedValue(successResult({ affectedFileIds: [], remainingReferenceCounts: {} }))
    const { SqliteMessageDataSource } = await import('../SqliteMessageDataSource')
    const store = (await import('@renderer/store')).default as unknown as { dispatch: ReturnType<typeof vi.fn> }
    const ds = new SqliteMessageDataSource({ insertMessageGroups: mocks.insertMessageGroups } as any)
    const groups = [
      {
        entries: [{ message: { id: 'm-1' }, blocks: [] }],
        intent: { kind: 'before-message', messageId: 'a-1' }
      }
    ] as any
    const result = await ds.insertMessageGroups('t-1', groups)
    expect(mocks.insertMessageGroups).toHaveBeenCalledTimes(1)
    expect(mocks.insertMessageGroups).toHaveBeenCalledWith({ topicId: 't-1', groups })
    expect(result).toEqual({ affectedFileIds: [], remainingReferenceCounts: {} })
    expect(store.dispatch).toHaveBeenCalledTimes(1)
    expect(mocks.updateTopicUpdatedAt).toHaveBeenCalledExactlyOnceWith({ topicId: 't-1' })
  })

  it('throws when bridge is missing', async () => {
    const { SqliteMessageDataSource } = await import('../SqliteMessageDataSource')
    const ds = new SqliteMessageDataSource({} as any)
    await expect(ds.insertMessageGroups('t-1', [] as any)).rejects.toThrow('insertMessageGroups not exposed')
  })
})
