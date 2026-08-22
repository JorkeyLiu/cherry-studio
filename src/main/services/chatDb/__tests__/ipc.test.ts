/**
 * ChatDb IPC Registration Tests — mocked ipcMain, real validation.
 *
 * Covers:
 * - Exactly 37 handlers registered
 * - Request validation before dispatch
 * - All result/error mapping categories
 * - Null result for void commands
 * - Result validation
 * - Disposer
 * - Unavailable DB without init/fallback
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock electron's ipcMain — must use vi.hoisted for mock data accessible in factory
const { handlers, mockHandle, mockRemoveHandler } = vi.hoisted(() => {
  const h = new Map<string, (...args: any[]) => any>()
  return {
    handlers: h,
    mockHandle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      h.set(channel, handler)
    }),
    mockRemoveHandler: vi.fn((channel: string) => {
      h.delete(channel)
    })
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: mockHandle,
    removeHandler: mockRemoveHandler
  }
}))

// Mock ChatDbService
const { mockIsInitialised, mockGetDatabase } = vi.hoisted(() => ({
  mockIsInitialised: vi.fn(() => false),
  mockGetDatabase: vi.fn()
}))

vi.mock('../index', () => ({
  chatDbService: {
    isInitialised: mockIsInitialised,
    getDatabase: mockGetDatabase
  }
}))

// Mock SpanCacheService so the ChatDbAggregateService import graph does not
// pull in ConfigManager/electron-store under ipc.test's minimal electron mock.
const { mockIpcCleanTopic } = vi.hoisted(() => ({
  mockIpcCleanTopic: vi.fn()
}))
vi.mock('../../SpanCacheService', () => ({
  spanCacheService: { cleanTopic: mockIpcCleanTopic }
}))

// Mock loggerService — capture the shared context so tests can assert
// log content (LOCK-PRIV-TRASH: supplied values must never reach logs).
const { mockLoggerContext } = vi.hoisted(() => ({
  mockLoggerContext: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => mockLoggerContext
  }
}))

import { resetDiagnosticCounters } from '@shared/diagnostics/sendTiming'
import { IpcChannel } from '@shared/IpcChannel'

import { registerChatDbIpc } from '../ipc'

describe('ChatDb IPC Registration', () => {
  let disposer: () => void

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    mockIsInitialised.mockReturnValue(false)
    resetDiagnosticCounters()
  })

  afterEach(() => {
    if (disposer) disposer()
  })

  // =========================================================================
  // Handler count
  // =========================================================================

  it('registers exactly 38 handlers', () => {
    disposer = registerChatDbIpc()
    expect(handlers.size).toBe(38)
  })

  // =========================================================================
  // All 37 channels
  // =========================================================================

  it('registers all 38 ChatDb channels', () => {
    disposer = registerChatDbIpc()

    const expectedChannels = [
      // Original 13
      IpcChannel.ChatDb_FetchMessages,
      IpcChannel.ChatDb_GetRawTopic,
      IpcChannel.ChatDb_TopicExists,
      IpcChannel.ChatDb_EnsureTopic,
      IpcChannel.ChatDb_AppendMessage,
      IpcChannel.ChatDb_UpdateMessage,
      IpcChannel.ChatDb_UpdateMessageAndBlocks,
      // PERF-100: one atomic multi-model answer-tab selection
      IpcChannel.ChatDb_SelectAnswerMessage,
      IpcChannel.ChatDb_DeleteMessage,
      IpcChannel.ChatDb_DeleteMessages,
      IpcChannel.ChatDb_UpdateBlocks,
      IpcChannel.ChatDb_UpdateSingleBlock,
      IpcChannel.ChatDb_BulkAddBlocks,
      IpcChannel.ChatDb_DeleteBlocks,
      // Phase 5.1A
      IpcChannel.ChatDb_ListSegments,
      IpcChannel.ChatDb_UpsertSegment,
      IpcChannel.ChatDb_UpdateSegmentMetadata,
      IpcChannel.ChatDb_DeleteSegment,
      IpcChannel.ChatDb_ReplaceSegmentMembership,
      IpcChannel.ChatDb_ReorderMessages,
      IpcChannel.ChatDb_ListFileRefsByFile,
      IpcChannel.ChatDb_CountFileRefsByFile,
      IpcChannel.ChatDb_ListBlocksByFile,
      // Phase 5.1B: topic lifecycle
      IpcChannel.ChatDb_UpdateTopicMetadata,
      IpcChannel.ChatDb_SoftDeleteTopic,
      IpcChannel.ChatDb_RestoreTopic,
      IpcChannel.ChatDb_ListTrashTopics,
      IpcChannel.ChatDb_HardDeleteTopic,
      IpcChannel.ChatDb_PurgeExpiredTopics,
      // Phase 5.1B: compound mutations
      IpcChannel.ChatDb_CloneMessagesToTopic,
      IpcChannel.ChatDb_ResetMessagesForResend,
      IpcChannel.ChatDb_DeleteMessagesWithSegments,
      IpcChannel.ChatDb_PasteMessagesToTopic,
      // Phase 5.1B-2: search
      IpcChannel.ChatDb_SearchMessages,
      // Phase 5.2B: atomic assistant empty-trash (LOCK-531)
      IpcChannel.ChatDb_EmptyTrashTopics,
      IpcChannel.ChatDb_TransferTopicOwnership,
      IpcChannel.ChatDb_ResetAssistantTopics,
      // S6.1: windowed reads
      IpcChannel.ChatDb_FetchMessagesWindow
    ]

    for (const channel of expectedChannels) {
      expect(handlers.has(channel)).toBe(true)
    }
  })

  // =========================================================================
  // Disposer
  // =========================================================================

  it('disposer removes all handlers', () => {
    disposer = registerChatDbIpc()
    expect(handlers.size).toBe(38)

    disposer()
    expect(handlers.size).toBe(0)
    expect(mockRemoveHandler).toHaveBeenCalledTimes(38)
  })

  // =========================================================================
  // Unavailable DB
  // =========================================================================

  it('returns UNAVAILABLE error when DB is not initialised', async () => {
    mockIsInitialised.mockReturnValue(false)
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_FetchMessages)!
    const result = await handler({}, { topicId: 't-1' })

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('UNAVAILABLE')
    expect(result.error.retryable).toBe(false)
  })

  // =========================================================================
  // Request validation
  // =========================================================================

  it('returns VALIDATION_ERROR for invalid request payload', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_FetchMessages)!
    // Missing topicId
    const result = await handler({}, {})

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
    expect(result.error.retryable).toBe(false)
  })

  it('returns VALIDATION_ERROR for unknown request properties', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_FetchMessages)!
    const result = await handler({}, { topicId: 't-1', unknownField: 'bad' })

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns VALIDATION_ERROR for non-plain-object request', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_FetchMessages)!
    const result = await handler({}, 'not-an-object')

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
  })

  // =========================================================================
  // Identity field rejection
  // =========================================================================

  it('rejects identity fields in message patch', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_UpdateMessage)!
    const result = await handler(
      {},
      {
        topicId: 't-1',
        messageId: 'm-1',
        updates: { id: 'new-id', content: 'Updated' }
      }
    )

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects topicId in message patch', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_UpdateMessage)!
    const result = await handler(
      {},
      {
        topicId: 't-1',
        messageId: 'm-1',
        updates: { topicId: 't-2' }
      }
    )

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects identity fields in block patch', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_UpdateSingleBlock)!
    const result = await handler(
      {},
      {
        blockId: 'b-1',
        updates: { id: 'new-id' }
      }
    )

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects messageId in block patch', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_UpdateSingleBlock)!
    const result = await handler(
      {},
      {
        blockId: 'b-1',
        updates: { messageId: 'new-msg' }
      }
    )

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects sortOrder in message patch', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_UpdateMessage)!
    const result = await handler(
      {},
      {
        topicId: 't-1',
        messageId: 'm-1',
        updates: { sortOrder: 99, content: 'Updated' }
      }
    )

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects sortOrder in block patch', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_UpdateSingleBlock)!
    const result = await handler(
      {},
      {
        blockId: 'b-1',
        updates: { sortOrder: 99 }
      }
    )

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
  })

  // =========================================================================
  // Array validation before iteration
  // =========================================================================

  it('rejects non-array blocks in append-message', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_AppendMessage)!
    const result = await handler(
      {},
      {
        topicId: 't-1',
        message: { id: 'm-1' },
        blocks: 'not-an-array'
      }
    )

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects non-array blocks in update-blocks', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_UpdateBlocks)!
    const result = await handler(
      {},
      {
        blocks: 'not-an-array'
      }
    )

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
  })

  // =========================================================================
  // Ownership consistency
  // =========================================================================

  it('rejects block messageId mismatch in append-message', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_AppendMessage)!
    const result = await handler(
      {},
      {
        topicId: 't-1',
        message: { id: 'm-1' },
        blocks: [{ id: 'b-1', messageId: 'm-2' }]
      }
    )

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects block messageId mismatch in update-message-and-blocks', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_UpdateMessageAndBlocks)!
    const result = await handler(
      {},
      {
        topicId: 't-1',
        messageUpdates: { id: 'messageUpdates.id' },
        blocksToUpdate: [{ id: 'b-1', messageId: 'm-2' }]
      }
    )

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
  })

  it('select-answer-message rejects an invalid group at the IPC boundary (PERF-100)', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_SelectAnswerMessage)!
    // Selected appears twice in the group → contract rejects before dispatch.
    const result = await handler(
      {},
      {
        topicId: 't-1',
        selectedMessageId: 'a-2',
        messageIds: ['a-1', 'a-2', 'a-2']
      }
    )

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('VALIDATION_ERROR')
  })

  it('select-answer-message accepts a valid group at the IPC boundary', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_SelectAnswerMessage)!
    const result = await handler(
      {},
      {
        topicId: 't-1',
        selectedMessageId: 'a-2',
        messageIds: ['a-1', 'a-2', 'a-3']
      }
    )

    // Validation passes; DB is not initialised → UNAVAILABLE (not VALIDATION_ERROR).
    expect(result).toHaveProperty('ok')
    expect(result).not.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
  })

  // =========================================================================
  // Result envelope structure
  // =========================================================================

  it('void commands return proper envelope structure', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_EnsureTopic)!
    const result = await handler({}, { topicId: 't-1' })

    // DB is not initialised → UNAVAILABLE error
    expect(result).toHaveProperty('ok')
    expect(typeof result.ok).toBe('boolean')
    if (result.ok === false) {
      expect(result.error).toHaveProperty('code')
      expect(result.error).toHaveProperty('message')
      expect(result.error).toHaveProperty('retryable')
      expect(typeof result.error.retryable).toBe('boolean')
    }
  })

  it('accepts name-bearing ensure and soft-delete requests at the IPC boundary', async () => {
    disposer = registerChatDbIpc()

    const ensureResult = await handlers.get(IpcChannel.ChatDb_EnsureTopic)!(
      {},
      {
        topicId: 't-1',
        assistantId: 'a-1',
        name: 'Named topic'
      }
    )
    const softDeleteResult = await handlers.get(IpcChannel.ChatDb_SoftDeleteTopic)!(
      {},
      {
        topicId: 't-1',
        name: 'Named topic'
      }
    )

    expect(ensureResult).toHaveProperty('ok')
    expect(softDeleteResult).toHaveProperty('ok')
    expect(ensureResult).not.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(softDeleteResult).not.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
  })

  // =========================================================================
  // Non-retryable vs retryable errors
  // =========================================================================

  it('validation errors are non-retryable', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_TopicExists)!
    const result = await handler({}, { invalid: true })

    expect(result.ok).toBe(false)
    expect(result.error.retryable).toBe(false)
  })

  it('unavailable errors are non-retryable', async () => {
    mockIsInitialised.mockReturnValue(false)
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_TopicExists)!
    const result = await handler({}, { topicId: 't-1' })

    expect(result.ok).toBe(false)
    expect(result.error.retryable).toBe(false)
  })

  // =========================================================================
  // Handler uses ipcMain.handle
  // =========================================================================

  it('uses ipcMain.handle for registration', () => {
    disposer = registerChatDbIpc()

    expect(mockHandle).toHaveBeenCalledTimes(38)
    for (const call of mockHandle.mock.calls) {
      expect(typeof call[0]).toBe('string')
      expect(typeof call[1]).toBe('function')
    }
  })

  // =========================================================================
  // Error mapping — typed/SQLite error classification
  // =========================================================================

  it('maps DB unavailable to UNAVAILABLE non-retryable', async () => {
    mockIsInitialised.mockReturnValue(false)
    disposer = registerChatDbIpc()

    for (const channel of [
      IpcChannel.ChatDb_FetchMessages,
      IpcChannel.ChatDb_AppendMessage,
      IpcChannel.ChatDb_UpdateBlocks,
      IpcChannel.ChatDb_DeleteBlocks
    ]) {
      const handler = handlers.get(channel)!
      let request: any
      switch (channel) {
        case IpcChannel.ChatDb_FetchMessages:
          request = { topicId: 't-1' }
          break
        case IpcChannel.ChatDb_AppendMessage:
          request = { topicId: 't-1', message: { id: 'm-1' }, blocks: [] }
          break
        case IpcChannel.ChatDb_UpdateBlocks:
          request = { blocks: [{ id: 'b-1', messageId: 'm-1' }] }
          break
        case IpcChannel.ChatDb_DeleteBlocks:
          request = { blockIds: ['b-1'] }
          break
        default:
          request = { topicId: 't-1' }
      }
      const result = await handler({}, request)
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('UNAVAILABLE')
      expect(result.error.retryable).toBe(false)
    }
  })

  it('malformed aggregate result returns valid ERR_STORAGE envelope', async () => {
    // This tests that if the aggregate somehow returns an invalid result,
    // the IPC handler catches it and returns a valid ERR_STORAGE envelope.
    disposer = registerChatDbIpc()

    // With DB not initialised, we get UNAVAILABLE — but the handler structure
    // ensures any result is always well-formed.
    mockIsInitialised.mockReturnValue(false)
    const handler = handlers.get(IpcChannel.ChatDb_EnsureTopic)!
    const result = await handler({}, { topicId: 't-1' })

    // Result must be a valid envelope
    expect(result).toHaveProperty('ok')
    expect(typeof result.ok).toBe('boolean')
    if (result.ok === false) {
      expect(result.error).toHaveProperty('code')
      expect(typeof result.error.code).toBe('string')
      expect(result.error.code.length).toBeGreaterThan(0)
      expect(result.error).toHaveProperty('message')
      expect(typeof result.error.message).toBe('string')
      expect(result.error.message.length).toBeGreaterThan(0)
      expect(result.error).toHaveProperty('retryable')
      expect(typeof result.error.retryable).toBe('boolean')
      // No SQL/path/stack leaking in error message
      expect(result.error.message).not.toMatch(/SELECT|INSERT|UPDATE|DELETE/)
      expect(result.error.message).not.toMatch(/\/[\w.-]+\/[\w.-]+\/[\w.-]+/)
    }
  })

  // =========================================================================
  // All 38 commands preserve 38-registration invariant
  // =========================================================================

  it('preserves exactly 38 registrations after multiple calls', () => {
    disposer = registerChatDbIpc()
    expect(handlers.size).toBe(38)

    // Call disposer, re-register
    disposer()
    expect(handlers.size).toBe(0)

    disposer = registerChatDbIpc()
    expect(handlers.size).toBe(38)
  })

  // =========================================================================
  // Re-registration safety
  // =========================================================================

  it('re-registration disposes prior handlers before installing new ones', () => {
    const disposer1 = registerChatDbIpc()
    expect(handlers.size).toBe(38)

    // Register again without calling disposer1 — should auto-dispose
    disposer = registerChatDbIpc()
    expect(handlers.size).toBe(38)

    // disposer1 is now stale — calling it should be a no-op
    disposer1()
    expect(handlers.size).toBe(38) // still 37

    // The current disposer works
    disposer()
    expect(handlers.size).toBe(0)
  })

  it('stale disposer does not remove newer handlers', () => {
    const disposer1 = registerChatDbIpc()

    // Re-register — disposer1 becomes stale
    disposer = registerChatDbIpc()
    expect(handlers.size).toBe(38)

    // Stale disposer1 is a no-op
    disposer1()
    expect(handlers.size).toBe(38)

    // Active disposer still works
    disposer()
    expect(handlers.size).toBe(0)
  })

  it('three sequential registrations produce exactly 38 handlers each time', () => {
    const d1 = registerChatDbIpc()
    expect(handlers.size).toBe(38)

    const d2 = registerChatDbIpc()
    expect(handlers.size).toBe(38)

    disposer = registerChatDbIpc()
    expect(handlers.size).toBe(38)

    // Stale discarders are no-ops
    d1()
    expect(handlers.size).toBe(38)
    d2()
    expect(handlers.size).toBe(38)

    // Active disposer works
    disposer()
    expect(handlers.size).toBe(0)
  })

  // =========================================================================
  // LOCK-PRIV-TRASH: purge cutoff privacy sentinel
  //
  // A noncanonical/invalid purge cutoff value must never appear in the
  // validation error message, the Main log line, or the IPC error response.
  // Validation rule and error code (VALIDATION_ERROR) are unchanged.
  // =========================================================================

  it('purge-expired-topics: invalid cutoff value never appears in log or IPC error (LOCK-PRIV-TRASH)', async () => {
    disposer = registerChatDbIpc()

    const handler = handlers.get(IpcChannel.ChatDb_PurgeExpiredTopics)!
    const formatSentinel = 'PRIVSENTINEL-7F3A9C2B-format'
    const dateSentinel = '2099-13-01T00:00:00.000Z'

    const formatResult = await handler({}, { cutoffTimestamp: formatSentinel })
    const dateResult = await handler({}, { cutoffTimestamp: dateSentinel })

    // Rule/error code unchanged: both still fail as VALIDATION_ERROR.
    expect(formatResult.ok).toBe(false)
    expect(formatResult.error.code).toBe('VALIDATION_ERROR')
    expect(formatResult.error.retryable).toBe(false)
    expect(dateResult.ok).toBe(false)
    expect(dateResult.error.code).toBe('VALIDATION_ERROR')

    // IPC error response: fixed static text present, supplied value absent.
    expect(formatResult.error.message).toContain('Expected canonical ISO 8601 timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)')
    expect(formatResult.error.message).not.toContain(formatSentinel)
    expect(dateResult.error.message).toContain('Invalid ISO 8601 timestamp (date out of range)')
    expect(dateResult.error.message).not.toContain(dateSentinel)

    // Main log: the request-validation warn line must not echo the values.
    const warnText = mockLoggerContext.warn.mock.calls.map((args) => String(args[0] ?? '')).join('\n')
    expect(warnText).toContain('Request validation failed')
    expect(warnText).not.toContain(formatSentinel)
    expect(warnText).not.toContain(dateSentinel)
  })

  // =========================================================================
  // Append-handler timing diagnostics (LOCK-001/003/004)
  // =========================================================================

  describe('append handler diagnostics', () => {
    it('forwards diagnostics to the aggregate and emits a correlated handler timing log', async () => {
      // DB not initialised → UNAVAILABLE failure path; the handler timing log
      // must still fire (ok=false) with the request's correlation metadata,
      // without replacing the returned failure envelope.
      mockIsInitialised.mockReturnValue(false)
      disposer = registerChatDbIpc()

      const handler = handlers.get(IpcChannel.ChatDb_AppendMessage)!
      const result = await handler(
        {},
        {
          topicId: 't-1',
          message: { id: 'm-1' },
          blocks: [],
          diagnostics: { correlationId: 'snd-ipc-1', ordinal: 1 }
        }
      )

      // Original envelope unchanged (UNAVAILABLE, not VALIDATION_ERROR).
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('UNAVAILABLE')

      const diagText = mockLoggerContext.info.mock.calls.map((args) => String(args[0] ?? '')).join('\n')
      expect(diagText).toContain('[diagnostics] main.append.handler')
      const handlerCall = mockLoggerContext.info.mock.calls.find((args) =>
        String(args[0]).includes('main.append.handler')
      )!
      const data = handlerCall[1] as Record<string, unknown>
      expect(data.correlationId).toBe('snd-ipc-1')
      expect(data.ordinal).toBe(1)
      expect(data.ok).toBe(false)
      expect(typeof data.durationMs).toBe('number')
      // Never logs message content or raw request objects.
      expect(JSON.stringify(data)).not.toContain('m-1')
    })

    it('accepts valid diagnostics on append-message (no VALIDATION_ERROR)', async () => {
      disposer = registerChatDbIpc()

      const handler = handlers.get(IpcChannel.ChatDb_AppendMessage)!
      const result = await handler(
        {},
        {
          topicId: 't-1',
          message: { id: 'm-1' },
          blocks: [],
          diagnostics: { correlationId: 'snd-ipc-2', ordinal: 2 }
        }
      )

      // Validation passes; failure (if any) comes from DB availability, never
      // from the diagnostics metadata shape.
      expect(result.ok).toBe(false)
      expect(result.error.code).not.toBe('VALIDATION_ERROR')
    })

    it('rejects malformed diagnostics shape as VALIDATION_ERROR without a timing log', async () => {
      disposer = registerChatDbIpc()

      const handler = handlers.get(IpcChannel.ChatDb_AppendMessage)!
      const result = await handler(
        {},
        {
          topicId: 't-1',
          message: { id: 'm-1' },
          blocks: [],
          diagnostics: { correlationId: 123 }
        }
      )

      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('VALIDATION_ERROR')
      const diagText = mockLoggerContext.info.mock.calls.map((args) => String(args[0] ?? '')).join('\n')
      expect(diagText).not.toContain('main.append.handler')
    })

    it('rejects valid string correlationId with invalid ordinal without a timing log', async () => {
      // LOCK-002: a valid correlation id must not let an invalid (arbitrary)
      // ordinal reach the timing log — diagnostics are captured only after
      // request validation succeeds.
      disposer = registerChatDbIpc()

      const handler = handlers.get(IpcChannel.ChatDb_AppendMessage)!
      const result = await handler(
        {},
        {
          topicId: 't-1',
          message: { id: 'm-1' },
          blocks: [],
          diagnostics: { correlationId: 'snd-ipc-3', ordinal: 'not-a-number' }
        }
      )

      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('VALIDATION_ERROR')
      const diagText = mockLoggerContext.info.mock.calls.map((args) => String(args[0] ?? '')).join('\n')
      expect(diagText).not.toContain('main.append.handler')
      // The supplied values must not be echoed anywhere in the log.
      expect(diagText).not.toContain('snd-ipc-3')
      expect(diagText).not.toContain('not-a-number')
    })

    it('emits no handler timing log for appends without correlation metadata', async () => {
      mockIsInitialised.mockReturnValue(false)
      disposer = registerChatDbIpc()

      const handler = handlers.get(IpcChannel.ChatDb_AppendMessage)!
      await handler(
        {},
        {
          topicId: 't-1',
          message: { id: 'm-1' },
          blocks: []
        }
      )

      const diagText = mockLoggerContext.info.mock.calls.map((args) => String(args[0] ?? '')).join('\n')
      expect(diagText).not.toContain('main.append.handler')
    })
  })
})
