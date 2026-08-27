/**
 * SqliteMessageDataSource Tests — using injected API spies.
 *
 * Covers:
 * - All 21 methods map to the intended named method/request
 * - fetch forceReload omitted
 * - raw null→undefined
 * - append -1 omitted, valid index included
 * - nested undefined omitted/null preserved/input not mutated/order preserved
 * - tool/model nested objects preserved
 * - unsupported JSON values, sparse/cycle/depth conditions reject locally
 * - ChatDbResultError fields
 * - transport error propagation
 * - no retry/fallback/second method calls
 * - topic timestamp dispatch only after successful relevant mutations
 * - SQLite datasource structurally has no file-count methods
 */

import { loggerService } from '@logger'
import type {
  AppendMessageRequest,
  BulkAddBlocksRequest,
  ChatDbResult,
  CloneMessagesToTopicRequest,
  CloneMessagesToTopicResponse,
  CountFileRefsByFileRequest,
  CountFileRefsByFileResponse,
  DeleteBlocksRequest,
  DeleteBlocksResponse,
  DeleteMessageRequest,
  DeleteMessagesRequest,
  DeleteMessagesWithSegmentsRequest,
  DeleteMessagesWithSegmentsResponse,
  DeleteSegmentRequest,
  EmptyTrashTopicsRequest,
  EmptyTrashTopicsResponse,
  EnsureTopicRequest,
  FetchMessagesRequest,
  FetchMessagesResponse,
  FileCleanupResult,
  GetRawTopicRequest,
  GetRawTopicResponse,
  HardDeleteTopicRequest,
  HardDeleteTopicResponse,
  JsonObject,
  ListBlocksByFileRequest,
  ListBlocksByFileResponse,
  ListFileRefsByFileRequest,
  ListFileRefsByFileResponse,
  ListSegmentsRequest,
  ListSegmentsResponse,
  ListTrashTopicsRequest,
  ListTrashTopicsResponse,
  PasteMessagesToTopicRequest,
  PasteMessagesToTopicResponse,
  PurgeExpiredTopicsRequest,
  PurgeExpiredTopicsResponse,
  ReorderMessagesRequest,
  ReplaceSegmentMembershipRequest,
  ReplaceSegmentMembershipResponse,
  ResetMessagesForResendRequest,
  ResetMessagesForResendResponse,
  RestoreTopicRequest,
  RestoreTopicResponse,
  SearchMessagesRequest,
  SearchMessagesResponse,
  SelectAnswerMessageRequest,
  SoftDeleteTopicRequest,
  TopicExistsRequest,
  UpdateBlocksRequest,
  UpdateMessageAndBlocksRequest,
  UpdateMessageRequest,
  UpdateSegmentMetadataRequest,
  UpdateSegmentMetadataResponse,
  UpdateSingleBlockRequest,
  UpdateTopicMetadataRequest,
  UpdateTopicMetadataResponse,
  UpsertSegmentRequest,
  UpsertSegmentResponse
} from '@shared/chatDb'
import { fail, ok } from '@shared/chatDb'
import { resetDiagnosticCounters } from '@shared/diagnostics/sendTiming'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSendDiagnosticsContext } from '../sendTimingDiagnostics'
import { ChatDbResultError, SqliteMessageDataSource } from '../SqliteMessageDataSource'

// ---------------------------------------------------------------------------
// Mock store and updateTopicUpdatedAt (hoisted to avoid init-before-use)
// ---------------------------------------------------------------------------

const { mockDispatch } = vi.hoisted(() => ({
  mockDispatch: vi.fn()
}))

vi.mock('@renderer/store', () => ({
  default: { dispatch: mockDispatch }
}))

vi.mock('@renderer/store/assistants', () => ({
  updateTopicUpdatedAt: vi.fn((payload: { topicId: string }) => ({
    type: 'assistants/updateTopicUpdatedAt',
    payload
  }))
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApiSpy() {
  return {
    fetchMessages: vi.fn<(request: FetchMessagesRequest) => Promise<ChatDbResult<FetchMessagesResponse>>>(),
    getRawTopic: vi.fn<(request: GetRawTopicRequest) => Promise<ChatDbResult<GetRawTopicResponse>>>(),
    topicExists: vi.fn<(request: TopicExistsRequest) => Promise<ChatDbResult<boolean>>>(),
    ensureTopic: vi.fn<(request: EnsureTopicRequest) => Promise<ChatDbResult<null>>>(),
    appendMessage: vi.fn<(request: AppendMessageRequest) => Promise<ChatDbResult<null>>>(),
    updateMessage: vi.fn<(request: UpdateMessageRequest) => Promise<ChatDbResult<null>>>(),
    updateMessageAndBlocks:
      vi.fn<(request: UpdateMessageAndBlocksRequest) => Promise<ChatDbResult<FileCleanupResult>>>(),
    selectAnswerMessage: vi.fn<(request: SelectAnswerMessageRequest) => Promise<ChatDbResult<null>>>(),
    deleteMessage: vi.fn<(request: DeleteMessageRequest) => Promise<ChatDbResult<null>>>(),
    deleteMessages: vi.fn<(request: DeleteMessagesRequest) => Promise<ChatDbResult<null>>>(),
    updateBlocks: vi.fn<(request: UpdateBlocksRequest) => Promise<ChatDbResult<null>>>(),
    updateSingleBlock: vi.fn<(request: UpdateSingleBlockRequest) => Promise<ChatDbResult<null>>>(),
    bulkAddBlocks: vi.fn<(request: BulkAddBlocksRequest) => Promise<ChatDbResult<null>>>(),
    listSegments: vi.fn<(request: ListSegmentsRequest) => Promise<ChatDbResult<ListSegmentsResponse>>>(),
    upsertSegment: vi.fn<(request: UpsertSegmentRequest) => Promise<ChatDbResult<UpsertSegmentResponse>>>(),
    updateSegmentMetadata:
      vi.fn<(request: UpdateSegmentMetadataRequest) => Promise<ChatDbResult<UpdateSegmentMetadataResponse>>>(),
    deleteSegment: vi.fn<(request: DeleteSegmentRequest) => Promise<ChatDbResult<null>>>(),
    replaceSegmentMembership:
      vi.fn<(request: ReplaceSegmentMembershipRequest) => Promise<ChatDbResult<ReplaceSegmentMembershipResponse>>>(),
    reorderMessages: vi.fn<(request: ReorderMessagesRequest) => Promise<ChatDbResult<null>>>(),
    listFileRefsByFile:
      vi.fn<(request: ListFileRefsByFileRequest) => Promise<ChatDbResult<ListFileRefsByFileResponse>>>(),
    countFileRefsByFile:
      vi.fn<(request: CountFileRefsByFileRequest) => Promise<ChatDbResult<CountFileRefsByFileResponse>>>(),
    listBlocksByFile: vi.fn<(request: ListBlocksByFileRequest) => Promise<ChatDbResult<ListBlocksByFileResponse>>>(),
    // Phase 5.1B: topic lifecycle
    updateTopicMetadata:
      vi.fn<(request: UpdateTopicMetadataRequest) => Promise<ChatDbResult<UpdateTopicMetadataResponse>>>(),
    softDeleteTopic: vi.fn<(request: SoftDeleteTopicRequest) => Promise<ChatDbResult<null>>>(),
    restoreTopic: vi.fn<(request: RestoreTopicRequest) => Promise<ChatDbResult<RestoreTopicResponse>>>(),
    listTrashTopics: vi.fn<(request: ListTrashTopicsRequest) => Promise<ChatDbResult<ListTrashTopicsResponse>>>(),
    hardDeleteTopic: vi.fn<(request: HardDeleteTopicRequest) => Promise<ChatDbResult<HardDeleteTopicResponse>>>(),
    purgeExpiredTopics:
      vi.fn<(request: PurgeExpiredTopicsRequest) => Promise<ChatDbResult<PurgeExpiredTopicsResponse>>>(),
    // Phase 5.2B: atomic assistant empty-trash (LOCK-531)
    emptyTrashTopics: vi.fn<(request: EmptyTrashTopicsRequest) => Promise<ChatDbResult<EmptyTrashTopicsResponse>>>(),
    // Phase 5.1B: compound mutations
    cloneMessagesToTopic:
      vi.fn<(request: CloneMessagesToTopicRequest) => Promise<ChatDbResult<CloneMessagesToTopicResponse>>>(),
    resetMessagesForResend:
      vi.fn<(request: ResetMessagesForResendRequest) => Promise<ChatDbResult<ResetMessagesForResendResponse>>>(),
    deleteBlocks: vi.fn<(request: DeleteBlocksRequest) => Promise<ChatDbResult<DeleteBlocksResponse>>>(),
    deleteMessagesWithSegments:
      vi.fn<
        (request: DeleteMessagesWithSegmentsRequest) => Promise<ChatDbResult<DeleteMessagesWithSegmentsResponse>>
      >(),
    pasteMessagesToTopic:
      vi.fn<(request: PasteMessagesToTopicRequest) => Promise<ChatDbResult<PasteMessagesToTopicResponse>>>(),
    // Phase 5.2A: search
    searchMessages: vi.fn<(request: SearchMessagesRequest) => Promise<ChatDbResult<SearchMessagesResponse>>>()
  }
}

function successResult<T>(value: T): ChatDbResult<T> {
  return ok(value)
}

function failureResult(code = 'TEST_ERROR', message = 'test failure'): ChatDbResult<never> {
  return fail(code, message, false)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SqliteMessageDataSource', () => {
  let api: ReturnType<typeof makeApiSpy>
  let ds: SqliteMessageDataSource

  beforeEach(() => {
    vi.clearAllMocks()
    api = makeApiSpy()
    ds = new SqliteMessageDataSource(api)
  })

  // =========================================================================
  // Method → API mapping
  // =========================================================================

  describe('method → API mapping', () => {
    it('fetchMessages calls api.fetchMessages with topicId', async () => {
      api.fetchMessages.mockResolvedValue(successResult({ messages: [], blocks: [] }))
      await ds.fetchMessages('topic-1')
      expect(api.fetchMessages).toHaveBeenCalledOnce()
      expect(api.fetchMessages).toHaveBeenCalledWith({ topicId: 'topic-1' })
    })

    it('getRawTopic calls api.getRawTopic with topicId', async () => {
      api.getRawTopic.mockResolvedValue(successResult({ id: 't1', messages: [] }))
      await ds.getRawTopic('topic-1')
      expect(api.getRawTopic).toHaveBeenCalledOnce()
      expect(api.getRawTopic).toHaveBeenCalledWith({ topicId: 'topic-1' })
    })

    it('topicExists calls api.topicExists with topicId', async () => {
      api.topicExists.mockResolvedValue(successResult(true))
      const result = await ds.topicExists('topic-1')
      expect(api.topicExists).toHaveBeenCalledOnce()
      expect(result).toBe(true)
    })

    it('ensureTopic calls api.ensureTopic with topicId', async () => {
      api.ensureTopic.mockResolvedValue(successResult(null))
      await ds.ensureTopic('topic-1')
      expect(api.ensureTopic).toHaveBeenCalledOnce()
      expect(api.ensureTopic).toHaveBeenCalledWith({ topicId: 'topic-1' })
    })

    it('appendMessage calls api.appendMessage with correct request', async () => {
      api.appendMessage.mockResolvedValue(successResult(null))
      const msg = { id: 'm-1', role: 'user', content: 'hi' } as any
      const blk = { id: 'b-1', messageId: 'm-1', type: 'main_text', content: 'hi' } as any
      await ds.appendMessage('topic-1', msg, [blk])
      expect(api.appendMessage).toHaveBeenCalledOnce()
      const req = api.appendMessage.mock.calls[0][0]
      expect(req.topicId).toBe('topic-1')
      expect(req.message.id).toBe('m-1')
      expect(req.blocks).toHaveLength(1)
      expect(req.insertIndex).toBeUndefined()
    })

    it('updateMessage calls api.updateMessage', async () => {
      api.updateMessage.mockResolvedValue(successResult(null))
      await ds.updateMessage('topic-1', 'msg-1', { content: 'updated' } as any)
      expect(api.updateMessage).toHaveBeenCalledOnce()
      const req = api.updateMessage.mock.calls[0][0]
      expect(req.topicId).toBe('topic-1')
      expect(req.messageId).toBe('msg-1')
      expect(req.updates.content).toBe('updated')
    })

    it('updateMessageAndBlocks calls api.updateMessageAndBlocks (strips topicId/sortOrder)', async () => {
      api.updateMessageAndBlocks.mockResolvedValue(successResult({ affectedFileIds: [], remainingReferenceCounts: {} }))
      const msgUpdates = { id: 'm-1', topicId: 't-1', sortOrder: 5, content: 'updated' } as any
      await ds.updateMessageAndBlocks('topic-1', msgUpdates, [])
      const req = api.updateMessageAndBlocks.mock.calls[0][0]
      expect(req.topicId).toBe('topic-1')
      expect(req.messageUpdates.id).toBe('m-1')
      expect(req.messageUpdates.topicId).toBeUndefined()
      expect(req.messageUpdates.sortOrder).toBeUndefined()
      expect(req.messageUpdates.content).toBe('updated')
    })

    it('selectAnswerMessage calls api.selectAnswerMessage with the closed request (PERF-100)', async () => {
      api.selectAnswerMessage.mockResolvedValue(successResult(null))
      await ds.selectAnswerMessage('topic-1', 'a-2', ['a-1', 'a-2', 'a-3'])
      expect(api.selectAnswerMessage).toHaveBeenCalledOnce()
      expect(api.selectAnswerMessage).toHaveBeenCalledWith({
        topicId: 'topic-1',
        selectedMessageId: 'a-2',
        messageIds: ['a-1', 'a-2', 'a-3']
      })
    })

    it('selectAnswerMessage propagates structured failure as ChatDbResultError', async () => {
      api.selectAnswerMessage.mockResolvedValue(failureResult('NOT_FOUND', 'Message does not belong to topic'))
      await expect(ds.selectAnswerMessage('topic-1', 'a-2', ['a-1', 'a-2', 'a-3'])).rejects.toBeInstanceOf(
        ChatDbResultError
      )
    })

    it('deleteMessage calls api.deleteMessage', async () => {
      api.deleteMessage.mockResolvedValue(successResult(null))
      await ds.deleteMessage('topic-1', 'msg-1')
      expect(api.deleteMessage).toHaveBeenCalledWith({ topicId: 'topic-1', messageId: 'msg-1' })
    })

    it('deleteMessages calls api.deleteMessages', async () => {
      api.deleteMessages.mockResolvedValue(successResult(null))
      await ds.deleteMessages('topic-1', ['m-1', 'm-2'])
      expect(api.deleteMessages).toHaveBeenCalledWith({ topicId: 'topic-1', messageIds: ['m-1', 'm-2'] })
    })

    it('updateBlocks calls api.updateBlocks', async () => {
      api.updateBlocks.mockResolvedValue(successResult(null))
      const blk = { id: 'b-1', messageId: 'm-1', type: 'main_text', content: 'x' } as any
      await ds.updateBlocks([blk])
      const req = api.updateBlocks.mock.calls[0][0]
      expect(req.blocks).toHaveLength(1)
    })

    it('updateSingleBlock calls api.updateSingleBlock', async () => {
      api.updateSingleBlock.mockResolvedValue(successResult(null))
      await ds.updateSingleBlock('blk-1', { content: 'updated' } as any)
      const req = api.updateSingleBlock.mock.calls[0][0]
      expect(req.blockId).toBe('blk-1')
      expect(req.updates.content).toBe('updated')
    })

    it('updateSingleBlock forwards an explicitly supplied stream diagnostic context', async () => {
      api.updateSingleBlock.mockResolvedValue(successResult(null))
      await ds.updateSingleBlock('blk-1', { content: 'updated' } as any, {
        correlationId: 'stm-e2e-1-abc',
        ordinal: 1
      })
      const req = api.updateSingleBlock.mock.calls[0][0]
      expect(req.diagnostics).toEqual({ correlationId: 'stm-e2e-1-abc', ordinal: 1 })
    })

    it('updateBlocks forwards an explicitly supplied stream diagnostic context', async () => {
      api.updateBlocks.mockResolvedValue(successResult(null))
      const blk = { id: 'b-1', messageId: 'm-1', type: 'main_text', content: 'x' } as any
      await ds.updateBlocks([blk], { correlationId: 'stm-e2e-2-abc', ordinal: 2 })
      const req = api.updateBlocks.mock.calls[0][0]
      expect(req.diagnostics).toEqual({ correlationId: 'stm-e2e-2-abc', ordinal: 2 })
    })

    it('bulkAddBlocks calls api.bulkAddBlocks', async () => {
      api.bulkAddBlocks.mockResolvedValue(successResult(null))
      const blk = { id: 'b-1', messageId: 'm-1', type: 'main_text' } as any
      await ds.bulkAddBlocks([blk])
      const req = api.bulkAddBlocks.mock.calls[0][0]
      expect(req.blocks).toHaveLength(1)
    })

    it('deleteBlocks calls api.deleteBlocks', async () => {
      api.deleteBlocks.mockResolvedValue(successResult({ affectedFileIds: [], remainingReferenceCounts: {} }))
      await ds.deleteBlocks(['b-1', 'b-2'])
      expect(api.deleteBlocks).toHaveBeenCalledWith({ blockIds: ['b-1', 'b-2'] })
    })

    // ---- Phase 5.1A: segment commands ----

    it('listSegments calls api.listSegments with topicId', async () => {
      api.listSegments.mockResolvedValue(successResult([]))
      await ds.listSegments('topic-1')
      expect(api.listSegments).toHaveBeenCalledOnce()
      expect(api.listSegments).toHaveBeenCalledWith({ topicId: 'topic-1' })
    })

    it('upsertSegment calls api.upsertSegment with full request', async () => {
      const segWire = {
        id: 'seg-1',
        topicId: 't1',
        name: 'Seg',
        messageIds: ['m1'],
        color: '#ff0000',
        createdAt: null,
        updatedAt: null
      }
      api.upsertSegment.mockResolvedValue(successResult(segWire))
      await ds.upsertSegment('seg-1', 't1', 'Seg', ['m1'], '#ff0000')
      expect(api.upsertSegment).toHaveBeenCalledOnce()
      const req = api.upsertSegment.mock.calls[0][0]
      expect(req.segmentId).toBe('seg-1')
      expect(req.topicId).toBe('t1')
      expect(req.name).toBe('Seg')
      expect(req.messageIds).toEqual(['m1'])
      expect(req.color).toBe('#ff0000')
    })

    it('updateSegmentMetadata calls api.updateSegmentMetadata', async () => {
      const segWire = { id: 'seg-1', topicId: 't1', name: 'Updated', messageIds: [], createdAt: null, updatedAt: null }
      api.updateSegmentMetadata.mockResolvedValue(successResult(segWire))
      await ds.updateSegmentMetadata('seg-1', 'Updated', '#00ff00')
      expect(api.updateSegmentMetadata).toHaveBeenCalledOnce()
      const req = api.updateSegmentMetadata.mock.calls[0][0]
      expect(req.segmentId).toBe('seg-1')
      expect(req.name).toBe('Updated')
      expect(req.color).toBe('#00ff00')
    })

    it('deleteSegment calls api.deleteSegment with segmentId', async () => {
      api.deleteSegment.mockResolvedValue(successResult(null))
      await ds.deleteSegment('seg-1')
      expect(api.deleteSegment).toHaveBeenCalledOnce()
      expect(api.deleteSegment).toHaveBeenCalledWith({ segmentId: 'seg-1' })
    })

    it('replaceSegmentMembership calls api.replaceSegmentMembership', async () => {
      const segWire = {
        id: 'seg-1',
        topicId: 't1',
        name: 'Seg',
        messageIds: ['m1', 'm2'],
        createdAt: null,
        updatedAt: null
      }
      api.replaceSegmentMembership.mockResolvedValue(successResult(segWire))
      await ds.replaceSegmentMembership('seg-1', ['m1', 'm2'])
      expect(api.replaceSegmentMembership).toHaveBeenCalledOnce()
      const req = api.replaceSegmentMembership.mock.calls[0][0]
      expect(req.segmentId).toBe('seg-1')
      expect(req.messageIds).toEqual(['m1', 'm2'])
    })

    it('replaceSegmentMembership handles null result (segment deleted)', async () => {
      api.replaceSegmentMembership.mockResolvedValue(successResult(null))
      const result = await ds.replaceSegmentMembership('seg-1', [])
      expect(result).toBeNull()
    })

    // ---- Phase 5.1A: message reorder ----

    it('reorderMessages calls api.reorderMessages', async () => {
      api.reorderMessages.mockResolvedValue(successResult(null))
      await ds.reorderMessages('topic-1', ['m3', 'm1', 'm2'])
      expect(api.reorderMessages).toHaveBeenCalledOnce()
      const req = api.reorderMessages.mock.calls[0][0]
      expect(req.topicId).toBe('topic-1')
      expect(req.messageIds).toEqual(['m3', 'm1', 'm2'])
    })

    // ---- Phase 5.1A: file reference queries ----

    it('listFileRefsByFile calls api.listFileRefsByFile with fileId', async () => {
      api.listFileRefsByFile.mockResolvedValue(successResult([]))
      await ds.listFileRefsByFile('file-1')
      expect(api.listFileRefsByFile).toHaveBeenCalledOnce()
      expect(api.listFileRefsByFile).toHaveBeenCalledWith({ fileId: 'file-1' })
    })

    it('countFileRefsByFile calls api.countFileRefsByFile with fileId', async () => {
      api.countFileRefsByFile.mockResolvedValue(successResult(3))
      const count = await ds.countFileRefsByFile('file-1')
      expect(api.countFileRefsByFile).toHaveBeenCalledOnce()
      expect(api.countFileRefsByFile).toHaveBeenCalledWith({ fileId: 'file-1' })
      expect(count).toBe(3)
    })

    it('listBlocksByFile calls api.listBlocksByFile with fileId', async () => {
      api.listBlocksByFile.mockResolvedValue(successResult([]))
      await ds.listBlocksByFile('file-1')
      expect(api.listBlocksByFile).toHaveBeenCalledOnce()
      expect(api.listBlocksByFile).toHaveBeenCalledWith({ fileId: 'file-1' })
    })
  })

  // =========================================================================
  // fetchMessages forceReload omitted
  // =========================================================================

  describe('fetchMessages forceReload omitted', () => {
    it('does not send forceReload even when provided', async () => {
      api.fetchMessages.mockResolvedValue(successResult({ messages: [], blocks: [] }))
      await ds.fetchMessages('topic-1', true)
      const req = api.fetchMessages.mock.calls[0][0]
      expect(req).toEqual({ topicId: 'topic-1' })
      expect((req as any).forceReload).toBeUndefined()
    })
  })

  // =========================================================================
  // getRawTopic null → undefined
  // =========================================================================

  describe('getRawTopic null → undefined', () => {
    it('maps wire null to renderer undefined', async () => {
      api.getRawTopic.mockResolvedValue(successResult(null))
      const result = await ds.getRawTopic('topic-1')
      expect(result).toBeUndefined()
    })

    it('maps wire object to renderer object', async () => {
      api.getRawTopic.mockResolvedValue(successResult({ id: 't-1', messages: [] }))
      const result = await ds.getRawTopic('topic-1')
      expect(result).toEqual({ id: 't-1', messages: [] })
    })
  })

  // =========================================================================
  // appendMessage insertIndex handling
  // =========================================================================

  describe('appendMessage insertIndex handling', () => {
    it('omits insertIndex when undefined', async () => {
      api.appendMessage.mockResolvedValue(successResult(null))
      const msg = { id: 'm-1' } as any
      await ds.appendMessage('t-1', msg, [])
      const req = api.appendMessage.mock.calls[0][0]
      expect('insertIndex' in req).toBe(false)
    })

    it('omits insertIndex when -1 sentinel', async () => {
      api.appendMessage.mockResolvedValue(successResult(null))
      const msg = { id: 'm-1' } as any
      await ds.appendMessage('t-1', msg, [], -1)
      const req = api.appendMessage.mock.calls[0][0]
      expect('insertIndex' in req).toBe(false)
    })

    it('sends valid non-negative insertIndex', async () => {
      api.appendMessage.mockResolvedValue(successResult(null))
      const msg = { id: 'm-1' } as any
      await ds.appendMessage('t-1', msg, [], 3)
      const req = api.appendMessage.mock.calls[0][0]
      expect(req.insertIndex).toBe(3)
    })
  })

  // =========================================================================
  // JSON boundary: undefined omitted, null preserved, order preserved
  // =========================================================================

  describe('JSON boundary', () => {
    it('omits undefined properties', () => {
      const clone = SqliteMessageDataSource._cloneForWire({ a: 1, b: undefined, c: null })
      expect(clone).toEqual({ a: 1, c: null })
      expect('b' in clone).toBe(false)
    })

    it('preserves null values', () => {
      const clone = SqliteMessageDataSource._cloneForWire({ a: null, b: [null, 1] })
      expect(clone).toEqual({ a: null, b: [null, 1] })
    })

    it('preserves insertion order', () => {
      const input: Record<string, unknown> = { z: 1, a: 2, m: 3 }
      const clone = SqliteMessageDataSource._cloneForWire(input)
      expect(Object.keys(clone)).toEqual(['z', 'a', 'm'])
    })

    it('deeply clones nested objects', () => {
      const inner = { x: 1 }
      const input = { nested: inner }
      const clone = SqliteMessageDataSource._cloneForWire(input)
      expect(clone.nested).toEqual({ x: 1 })
      expect(clone.nested).not.toBe(inner) // different reference
    })

    it('does not mutate input', () => {
      const input: Record<string, unknown> = { a: 1, b: { c: 2 } }
      const original = { ...input }
      SqliteMessageDataSource._cloneForWire(input)
      expect(input).toEqual(original)
    })
  })

  // =========================================================================
  // Nested tool/model objects preserved
  // =========================================================================

  describe('nested objects preserved', () => {
    it('preserves tool block object content', () => {
      const toolContent = { result: 'data', items: [1, 2, 3] }
      const input = { type: 'tool', content: toolContent, id: 'b-1' }
      const clone = SqliteMessageDataSource._cloneForWire(input)
      expect(clone.content).toEqual(toolContent)
      expect(clone.content).not.toBe(toolContent) // cloned
    })

    it('preserves structured model object', () => {
      const model = {
        id: 'gpt-4',
        provider: 'openai',
        name: 'GPT-4',
        group: 'gpt',
        capabilities: [{ type: 'text' }]
      }
      const input = { model, modelId: 'gpt-4' }
      const clone = SqliteMessageDataSource._cloneForWire(input)
      expect(clone.model).toEqual(model)
      expect(clone.model).not.toBe(model)
    })
  })

  // =========================================================================
  // Unsupported JSON values reject locally
  // =========================================================================

  describe('unsupported values reject locally', () => {
    it('rejects bigint', () => {
      expect(() => SqliteMessageDataSource._cloneForWire({ v: BigInt(42) })).toThrow(TypeError)
    })

    it('rejects symbol', () => {
      expect(() => SqliteMessageDataSource._cloneForWire({ v: Symbol('x') })).toThrow(TypeError)
    })

    it('rejects function', () => {
      expect(() => SqliteMessageDataSource._cloneForWire({ v: () => {} })).toThrow(TypeError)
    })

    it('rejects Date', () => {
      expect(() => SqliteMessageDataSource._cloneForWire({ v: new Date() })).toThrow(TypeError)
    })

    it('rejects Map', () => {
      expect(() => SqliteMessageDataSource._cloneForWire({ v: new Map() })).toThrow(TypeError)
    })

    it('rejects Set', () => {
      expect(() => SqliteMessageDataSource._cloneForWire({ v: new Set() })).toThrow(TypeError)
    })

    it('rejects TypedArray (Uint8Array)', () => {
      expect(() => SqliteMessageDataSource._cloneForWire({ v: new Uint8Array([1]) })).toThrow(TypeError)
    })

    it('rejects non-finite number (NaN)', () => {
      expect(() => SqliteMessageDataSource._cloneForWire({ v: NaN })).toThrow(TypeError)
    })

    it('rejects non-finite number (Infinity)', () => {
      expect(() => SqliteMessageDataSource._cloneForWire({ v: Infinity })).toThrow(TypeError)
    })

    it('rejects sparse arrays', () => {
      // Build a sparse array without literal holes: index 1 is a hole.
      const sparse: number[] = []
      sparse[0] = 1
      sparse[2] = 3
      expect(1 in sparse).toBe(false)
      expect(() => SqliteMessageDataSource._cloneForWire(sparse)).toThrow(TypeError)
    })

    it('rejects undefined in arrays', () => {
      expect(() => SqliteMessageDataSource._cloneForWire([1, undefined, 3])).toThrow(TypeError)
    })

    it('rejects cyclic references', () => {
      const obj: Record<string, unknown> = { a: 1 }
      obj.self = obj
      expect(() => SqliteMessageDataSource._cloneForWire(obj)).toThrow(/cyclic/)
    })

    it('rejects class instances', () => {
      class Custom {
        value = 42
      }
      expect(() => SqliteMessageDataSource._cloneForWire({ v: new Custom() })).toThrow(TypeError)
    })

    it('rejects deeply nested beyond depth limit', () => {
      let deep: any = 1
      for (let i = 0; i <= 25; i++) {
        deep = { v: deep }
      }
      expect(() => SqliteMessageDataSource._cloneForWire(deep)).toThrow(/depth/)
    })

    it('accepts RegExp is rejected', () => {
      expect(() => SqliteMessageDataSource._cloneForWire({ v: /abc/ })).toThrow(TypeError)
    })
  })

  // =========================================================================
  // ChatDbResultError
  // =========================================================================

  describe('ChatDbResultError', () => {
    it('carries code, message, retryable, details', () => {
      const err = new ChatDbResultError({
        code: 'NOT_FOUND',
        message: 'Topic not found',
        retryable: false,
        details: { topicId: 't-1' }
      })
      expect(err.name).toBe('ChatDbResultError')
      expect(err.code).toBe('NOT_FOUND')
      expect(err.message).toBe('Topic not found')
      expect(err.retryable).toBe(false)
      expect(err.details).toEqual({ topicId: 't-1' })
    })

    it('details is undefined when not provided', () => {
      const err = new ChatDbResultError({
        code: 'ERR',
        message: 'msg',
        retryable: true
      })
      expect(err.details).toBeUndefined()
    })

    it('is an instance of Error', () => {
      const err = new ChatDbResultError({ code: 'X', message: 'y', retryable: false })
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(ChatDbResultError)
    })
  })

  // =========================================================================
  // Transport error propagation
  // =========================================================================

  describe('transport error propagation', () => {
    it('transport rejection propagates unchanged (not wrapped)', async () => {
      const transportError = new Error('IPC transport failed')
      api.fetchMessages.mockRejectedValue(transportError)
      await expect(ds.fetchMessages('t-1')).rejects.toThrow('IPC transport failed')
      await expect(ds.fetchMessages('t-1')).rejects.not.toBeInstanceOf(ChatDbResultError)
    })

    it('structured failure throws ChatDbResultError', async () => {
      api.fetchMessages.mockResolvedValue(failureResult('NOT_FOUND', 'Topic missing'))
      try {
        await ds.fetchMessages('t-1')
        expect.fail('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ChatDbResultError)
        expect((e as ChatDbResultError).code).toBe('NOT_FOUND')
        expect((e as ChatDbResultError).message).toBe('Topic missing')
      }
    })
  })

  // =========================================================================
  // No retry/fallback
  // =========================================================================

  describe('no retry/fallback', () => {
    it('does not retry on failure', async () => {
      api.fetchMessages.mockResolvedValue(failureResult('ERR', 'fail'))
      try {
        await ds.fetchMessages('t-1')
      } catch {
        // expected
      }
      expect(api.fetchMessages).toHaveBeenCalledOnce()
      // No second call
    })

    it('does not call alternative methods on failure', async () => {
      api.appendMessage.mockResolvedValue(failureResult('ERR', 'fail'))
      try {
        await ds.appendMessage('t-1', { id: 'm-1' } as any, [])
      } catch {
        // expected
      }
      expect(api.appendMessage).toHaveBeenCalledOnce()
      expect(api.updateMessage).not.toHaveBeenCalled()
      expect(api.updateMessageAndBlocks).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Phase 5.1B: topic lifecycle + compound mutations
  // =========================================================================

  describe('Phase 5.1B: topic lifecycle', () => {
    it('updateTopicMetadata calls api with correct request', async () => {
      const wire = { id: 't-1', name: 'New', pinned: true }
      api.updateTopicMetadata.mockResolvedValue(successResult(wire))
      const result = await ds.updateTopicMetadata('t-1', 'New', true, undefined, undefined)
      expect(api.updateTopicMetadata).toHaveBeenCalledOnce()
      expect(result).toEqual(wire)
    })

    it('softDeleteTopic calls api and dispatches', async () => {
      api.softDeleteTopic.mockResolvedValue(successResult(null))
      await ds.softDeleteTopic('t-1', 'Named topic')
      expect(api.softDeleteTopic).toHaveBeenCalledOnce()
      expect(api.softDeleteTopic).toHaveBeenCalledWith({ topicId: 't-1', name: 'Named topic' })
      expect(mockDispatch).toHaveBeenCalledOnce()
    })

    it('restoreTopic returns the restored wire and dispatches (LOCK-532)', async () => {
      const wire = { id: 't-1', assistantId: 'a-1', name: 'Restored' }
      api.restoreTopic.mockResolvedValue(successResult(wire))
      const result = await ds.restoreTopic('t-1')
      expect(api.restoreTopic).toHaveBeenCalledOnce()
      expect(api.restoreTopic).toHaveBeenCalledWith({ topicId: 't-1' })
      expect(result).toEqual(wire)
      expect(mockDispatch).toHaveBeenCalledOnce()
    })

    it('restoreTopic returns null without dispatching when nothing was restored', async () => {
      api.restoreTopic.mockResolvedValue(successResult(null))
      const result = await ds.restoreTopic('t-1')
      expect(result).toBeNull()
      expect(mockDispatch).not.toHaveBeenCalled()
    })

    it('listTrashTopics calls api with correct request', async () => {
      api.listTrashTopics.mockResolvedValue(successResult({ items: [{ id: 't-1' }], hasMore: false }))
      const result = await ds.listTrashTopics('a-1', 10, 'cursor')
      expect(api.listTrashTopics).toHaveBeenCalledOnce()
      expect(result.items.length).toBe(1)
    })

    it('hardDeleteTopic calls api and dispatches', async () => {
      api.hardDeleteTopic.mockResolvedValue(
        successResult({ affectedFileIds: ['f1'], remainingReferenceCounts: { f1: 0 }, deletedTopicIds: ['t-1'] })
      )
      const result = await ds.hardDeleteTopic('t-1')
      expect(api.hardDeleteTopic).toHaveBeenCalledOnce()
      // Intentional resident-registry deletion lifecycle dispatches + topic updatedAt dispatch
      expect(mockDispatch).toHaveBeenCalledTimes(2)
      const callTypes = mockDispatch.mock.calls.map((c: any[]) => c[0]?.type)
      expect(callTypes).toEqual(
        expect.arrayContaining(['residentRegistry/invalidateForDeletion', 'assistants/updateTopicUpdatedAt'])
      )
      expect(result.affectedFileIds).toEqual(['f1'])
      expect(result.deletedTopicIds).toEqual(['t-1'])
    })

    it('purgeExpiredTopics calls api', async () => {
      api.purgeExpiredTopics.mockResolvedValue(
        successResult({ affectedFileIds: [], remainingReferenceCounts: {}, deletedTopicIds: [] })
      )
      const result = await ds.purgeExpiredTopics('2025-01-01T00:00:00.000Z')
      expect(api.purgeExpiredTopics).toHaveBeenCalledOnce()
      expect(result.affectedFileIds).toEqual([])
      expect(result.deletedTopicIds).toEqual([])
    })

    it('emptyTrashTopics is ONE api call returning the aggregate cleanup (LOCK-531)', async () => {
      api.emptyTrashTopics.mockResolvedValue(
        successResult({ affectedFileIds: ['f1'], remainingReferenceCounts: { f1: 0 }, deletedTopicIds: ['t-a'] })
      )
      const result = await ds.emptyTrashTopics('a-1')
      expect(api.emptyTrashTopics).toHaveBeenCalledOnce()
      expect(api.emptyTrashTopics).toHaveBeenCalledWith({ assistantId: 'a-1' })
      // No list+loop: no other lifecycle command is issued.
      expect(api.listTrashTopics).not.toHaveBeenCalled()
      expect(api.hardDeleteTopic).not.toHaveBeenCalled()
      expect(result.affectedFileIds).toEqual(['f1'])
    })

    it('ensureTopic forwards assistantId for creation ownership (LOCK-533)', async () => {
      api.ensureTopic.mockResolvedValue(successResult(null))
      await ds.ensureTopic('t-1', 'a-1', 'Named topic')
      expect(api.ensureTopic).toHaveBeenCalledWith({ topicId: 't-1', assistantId: 'a-1', name: 'Named topic' })
    })

    it('ensureTopic omits assistantId when not provided', async () => {
      api.ensureTopic.mockResolvedValue(successResult(null))
      await ds.ensureTopic('t-1')
      expect(api.ensureTopic).toHaveBeenCalledWith({ topicId: 't-1' })
    })
  })

  describe('Phase 5.1B: compound mutations', () => {
    it('cloneMessagesToTopic calls api and dispatches', async () => {
      api.cloneMessagesToTopic.mockResolvedValue(successResult(null))
      await ds.cloneMessagesToTopic('t-1', [{ message: { id: 'm1' }, blocks: [{ id: 'b1', messageId: 'm1' }] }], 'a1')
      expect(api.cloneMessagesToTopic).toHaveBeenCalledOnce()
      expect(mockDispatch).toHaveBeenCalledOnce()
    })

    it('cloneMessagesToTopic sends duplicated independent clones for messages sharing one model object (LOCK-N6)', async () => {
      api.cloneMessagesToTopic.mockResolvedValue(successResult(null))
      // Real call shape: createAssistantMessage stores `model: assistant.model`
      // — the SAME object reference on every assistant message — so one
      // cloneForWire invocation over the entries array contains a shared
      // non-cyclic graph. This must serialize as duplicated valid JSON, not
      // throw `cyclic reference detected`.
      const model = { id: 'gpt-4', provider: 'openai', name: 'GPT-4', group: 'gpt', capabilities: [{ type: 'text' }] }
      const mkMessage = (id: string): JsonObject => ({ id, role: 'assistant', model })
      await ds.cloneMessagesToTopic(
        't-1',
        [
          { message: mkMessage('m-1'), blocks: [{ id: 'b-1', messageId: 'm-1', type: 'main_text', content: 'a' }] },
          { message: mkMessage('m-2'), blocks: [{ id: 'b-2', messageId: 'm-2', type: 'main_text', content: 'b' }] }
        ],
        'a-1'
      )
      expect(api.cloneMessagesToTopic).toHaveBeenCalledOnce()
      const req = api.cloneMessagesToTopic.mock.calls[0][0]
      const modelA = req.entries[0].message.model as Record<string, unknown>
      const modelB = req.entries[1].message.model as Record<string, unknown>
      expect(modelA).toEqual(model)
      expect(modelB).toEqual(model)
      // Duplicated equal-but-independent clones — never the shared reference.
      expect(modelA).not.toBe(modelB)
      expect(modelA).not.toBe(model)
      expect(modelB).not.toBe(model)
      expect(mockDispatch).toHaveBeenCalledOnce()
    })

    it('resetMessagesForResend calls api and dispatches', async () => {
      api.resetMessagesForResend.mockResolvedValue(
        successResult({ affectedFileIds: ['f1'], remainingReferenceCounts: { f1: 0 } })
      )
      const result = await ds.resetMessagesForResend('t-1', [{ message: { id: 'm1' }, blocks: [] }], ['b1'])
      expect(api.resetMessagesForResend).toHaveBeenCalledOnce()
      expect(mockDispatch).toHaveBeenCalledOnce()
      expect(result.affectedFileIds).toEqual(['f1'])
    })

    it('deleteMessagesWithSegments calls api and dispatches', async () => {
      api.deleteMessagesWithSegments.mockResolvedValue(
        successResult({ affectedFileIds: [], remainingReferenceCounts: {} })
      )
      const result = await ds.deleteMessagesWithSegments('t-1', ['m1'])
      expect(api.deleteMessagesWithSegments).toHaveBeenCalledOnce()
      expect(mockDispatch).toHaveBeenCalledOnce()
      expect(result.affectedFileIds).toEqual([])
    })

    it('pasteMessagesToTopic calls api and dispatches', async () => {
      api.pasteMessagesToTopic.mockResolvedValue(successResult({ affectedFileIds: [], remainingReferenceCounts: {} }))
      const result = await ds.pasteMessagesToTopic('t-1', [], 0)
      expect(api.pasteMessagesToTopic).toHaveBeenCalledOnce()
      expect(mockDispatch).toHaveBeenCalledOnce()
      expect(result.affectedFileIds).toEqual([])
    })
  })

  // =========================================================================
  // Phase 5.2A: search
  // =========================================================================

  describe('Phase 5.2A: searchMessages', () => {
    const emptyResponse: SearchMessagesResponse = { items: [], hasMore: false, totalCount: 0 }

    it('calls api.searchMessages with exact request (no cursor on first page)', async () => {
      api.searchMessages.mockResolvedValue(successResult(emptyResponse))
      await ds.searchMessages({ keywords: 'hello world', matchMode: 'whole-word', sortOrder: 'newest', pageSize: 10 })
      expect(api.searchMessages).toHaveBeenCalledOnce()
      expect(api.searchMessages).toHaveBeenCalledWith({
        keywords: 'hello world',
        matchMode: 'whole-word',
        sortOrder: 'newest',
        pageSize: 10
      })
      const req = api.searchMessages.mock.calls[0][0]
      expect('cursor' in req).toBe(false)
    })

    it('passes the opaque cursor through unchanged', async () => {
      api.searchMessages.mockResolvedValue(successResult(emptyResponse))
      await ds.searchMessages({
        keywords: 'foo',
        matchMode: 'substring',
        sortOrder: 'oldest',
        pageSize: 10,
        cursor: 'b3BhcXVl'
      })
      expect(api.searchMessages).toHaveBeenCalledWith({
        keywords: 'foo',
        matchMode: 'substring',
        sortOrder: 'oldest',
        pageSize: 10,
        cursor: 'b3BhcXVl'
      })
    })

    it('returns the unwrapped response value', async () => {
      const response: SearchMessagesResponse = {
        items: [
          {
            blockId: 'b1',
            messageId: 'm1',
            topicId: 't1',
            topicName: 'Topic 1',
            rawContent: 'hello world',
            messageCreatedAt: '2026-01-01T00:00:00.000Z'
          }
        ],
        nextCursor: 'bmV4dA',
        hasMore: true,
        totalCount: 11
      }
      api.searchMessages.mockResolvedValue(successResult(response))
      const result = await ds.searchMessages({
        keywords: 'hello',
        matchMode: 'whole-word',
        sortOrder: 'newest',
        pageSize: 10
      })
      expect(result).toEqual(response)
    })

    it('structured failure throws ChatDbResultError without retry or fallback', async () => {
      api.searchMessages.mockResolvedValue(failureResult('SEARCH_ERROR', 'search failed'))
      try {
        await ds.searchMessages({ keywords: 'x', matchMode: 'whole-word', sortOrder: 'newest', pageSize: 10 })
        expect.fail('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ChatDbResultError)
        expect((e as ChatDbResultError).code).toBe('SEARCH_ERROR')
      }
      expect(api.searchMessages).toHaveBeenCalledOnce()
      expect(api.fetchMessages).not.toHaveBeenCalled()
    })

    it('transport rejection propagates unchanged', async () => {
      api.searchMessages.mockRejectedValue(new Error('IPC transport failed'))
      await expect(
        ds.searchMessages({ keywords: 'x', matchMode: 'whole-word', sortOrder: 'newest', pageSize: 10 })
      ).rejects.toThrow('IPC transport failed')
    })

    it('does NOT dispatch topic timestamp update (read-only)', async () => {
      mockDispatch.mockClear()
      api.searchMessages.mockResolvedValue(successResult(emptyResponse))
      await ds.searchMessages({ keywords: 'x', matchMode: 'whole-word', sortOrder: 'newest', pageSize: 10 })
      expect(mockDispatch).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // S6.2b R-05: fetchAnswerGroup (authoritative READ)
  // =========================================================================

  describe('S6.2b R-05: fetchAnswerGroup', () => {
    const answerGroupResponse = {
      completeness: 'answer-group' as const,
      topicId: 't1',
      anchorMessageId: 'a2',
      askId: 'ask-1',
      messageIds: ['a1', 'a2', 'a3']
    }

    it('calls api.fetchAnswerGroup with exact stable request', async () => {
      ;(api as any).fetchAnswerGroup = vi.fn().mockResolvedValue(successResult(answerGroupResponse))
      await ds.fetchAnswerGroup('t1', 'a2')
      expect((api as any).fetchAnswerGroup).toHaveBeenCalledOnce()
      expect((api as any).fetchAnswerGroup).toHaveBeenCalledWith({ topicId: 't1', anchorMessageId: 'a2' })
    })

    it('returns the unwrapped response value', async () => {
      ;(api as any).fetchAnswerGroup = vi.fn().mockResolvedValue(successResult(answerGroupResponse))
      const result = await ds.fetchAnswerGroup('t1', 'a2')
      expect(result).toEqual(answerGroupResponse)
    })

    it('structured failure throws ChatDbResultError without retry or fallback', async () => {
      ;(api as any).fetchAnswerGroup = vi
        .fn()
        .mockResolvedValue(failureResult('NOT_FOUND', 'Anchor has no actionable group'))
      try {
        await ds.fetchAnswerGroup('t1', 'missing')
        expect.fail('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(ChatDbResultError)
        expect((e as ChatDbResultError).code).toBe('NOT_FOUND')
      }
      expect((api as any).fetchAnswerGroup).toHaveBeenCalledOnce()
      expect(api.fetchMessages).not.toHaveBeenCalled()
      expect(api.selectAnswerMessage).not.toHaveBeenCalled()
    })

    it('transport rejection propagates unchanged', async () => {
      ;(api as any).fetchAnswerGroup = vi.fn().mockRejectedValue(new Error('IPC transport failed'))
      await expect(ds.fetchAnswerGroup('t1', 'a2')).rejects.toThrow('IPC transport failed')
    })

    it('does NOT dispatch topic timestamp update (read-only)', async () => {
      mockDispatch.mockClear()
      ;(api as any).fetchAnswerGroup = vi.fn().mockResolvedValue(successResult(answerGroupResponse))
      await ds.fetchAnswerGroup('t1', 'a2')
      expect(mockDispatch).not.toHaveBeenCalled()
    })

    it('does NOT dispatch when fetchAnswerGroup fails', async () => {
      mockDispatch.mockClear()
      ;(api as any).fetchAnswerGroup = vi.fn().mockResolvedValue(failureResult('NOT_FOUND', 'no group'))
      try {
        await ds.fetchAnswerGroup('t1', 'missing')
      } catch {
        // expected
      }
      expect(mockDispatch).not.toHaveBeenCalled()
    })

    it('rejects locally on unsupported JSON values via cloneForWire', async () => {
      ;(api as any).fetchAnswerGroup = vi.fn().mockResolvedValue(successResult(answerGroupResponse))
      await expect(ds.fetchAnswerGroup('t1', BigInt(42) as unknown as string)).rejects.toThrow(TypeError)
      expect((api as any).fetchAnswerGroup).not.toHaveBeenCalled()
    })
  })

  // S6.3 R-06: fetchContextClosure (authoritative READ)
  describe('S6.3 R-06: fetchContextClosure', () => {
    const closureResponse = {
      messages: [{ id: 'u1' }, { id: 'a1' }] as any,
      blocks: [] as any,
      closure: {
        completeness: 'context-closure' as const,
        topicId: 't1',
        anchorGroupKey: 'u1',
        firstMessageId: 'u1',
        lastMessageId: 'a1',
        returnedCount: 2
      }
    }
    it('calls api.fetchContextClosure with exact request', async () => {
      ;(api as any).fetchContextClosure = vi.fn().mockResolvedValue(successResult(closureResponse))
      await ds.fetchContextClosure({ topicId: 't1', anchorGroupKey: 'u1' })
      expect((api as any).fetchContextClosure).toHaveBeenCalledOnce()
      expect((api as any).fetchContextClosure).toHaveBeenCalledWith({ topicId: 't1', anchorGroupKey: 'u1' })
    })
    it('returns unwrapped closure', async () => {
      ;(api as any).fetchContextClosure = vi.fn().mockResolvedValue(successResult(closureResponse))
      const res = await ds.fetchContextClosure({ topicId: 't1', anchorGroupKey: 'u1' })
      expect(res).toEqual(closureResponse)
    })
    it('structured failure throws ChatDbResultError', async () => {
      ;(api as any).fetchContextClosure = vi.fn().mockResolvedValue(failureResult('NOT_FOUND', 'no anchor'))
      await expect(ds.fetchContextClosure({ topicId: 't1', anchorGroupKey: 'missing' })).rejects.toBeInstanceOf(
        ChatDbResultError
      )
    })
    it('transport rejection propagates', async () => {
      ;(api as any).fetchContextClosure = vi.fn().mockRejectedValue(new Error('IPC fail'))
      await expect(ds.fetchContextClosure({ topicId: 't1', anchorGroupKey: 'u1' })).rejects.toThrow('IPC fail')
    })
    it('does NOT dispatch timestamp (read-only)', async () => {
      mockDispatch.mockClear()
      ;(api as any).fetchContextClosure = vi.fn().mockResolvedValue(successResult(closureResponse))
      await ds.fetchContextClosure({ topicId: 't1', anchorGroupKey: 'u1' })
      expect(mockDispatch).not.toHaveBeenCalled()
    })
    it('rejects on unsupported JSON via cloneForWire', async () => {
      ;(api as any).fetchContextClosure = vi.fn().mockResolvedValue(successResult(closureResponse))
      await expect(ds.fetchContextClosure({ topicId: 't1', anchorGroupKey: BigInt(1) as any })).rejects.toThrow(
        TypeError
      )
      expect((api as any).fetchContextClosure).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // updateTopicUpdatedAt dispatch parity
  // =========================================================================

  describe('updateTopicUpdatedAt dispatch', () => {
    const dispatchesAfter = async (method: () => Promise<unknown>) => {
      mockDispatch.mockClear()
      await method()
      expect(mockDispatch).toHaveBeenCalledOnce()
    }

    const doesNotDispatchAfter = async (method: () => Promise<unknown>) => {
      mockDispatch.mockClear()
      await method()
      expect(mockDispatch).not.toHaveBeenCalled()
    }

    it('dispatches after appendMessage', async () => {
      api.appendMessage.mockResolvedValue(successResult(null))
      await dispatchesAfter(() => ds.appendMessage('t-1', { id: 'm-1' } as any, []))
    })

    it('dispatches after updateMessage', async () => {
      api.updateMessage.mockResolvedValue(successResult(null))
      await dispatchesAfter(() => ds.updateMessage('t-1', 'm-1', {} as any))
    })

    it('dispatches after updateMessageAndBlocks', async () => {
      api.updateMessageAndBlocks.mockResolvedValue(successResult({ affectedFileIds: [], remainingReferenceCounts: {} }))
      await dispatchesAfter(() => ds.updateMessageAndBlocks('t-1', { id: 'm-1' } as any, []))
    })

    it('dispatches EXACTLY ONCE after selectAnswerMessage (PERF-100 one timestamp per logical selection)', async () => {
      api.selectAnswerMessage.mockResolvedValue(successResult(null))
      await dispatchesAfter(() => ds.selectAnswerMessage('t-1', 'a-2', ['a-1', 'a-2', 'a-3']))
    })

    it('does NOT dispatch when selectAnswerMessage fails (no commit on DB failure)', async () => {
      api.selectAnswerMessage.mockResolvedValue(failureResult('NOT_FOUND', 'Message does not belong to topic'))
      mockDispatch.mockClear()
      try {
        await ds.selectAnswerMessage('t-1', 'a-2', ['a-1', 'a-2', 'a-3'])
      } catch {
        // expected
      }
      expect(mockDispatch).not.toHaveBeenCalled()
    })

    it('dispatches after deleteMessage', async () => {
      api.deleteMessage.mockResolvedValue(successResult(null))
      await dispatchesAfter(() => ds.deleteMessage('t-1', 'm-1'))
    })

    it('dispatches after deleteMessages', async () => {
      api.deleteMessages.mockResolvedValue(successResult(null))
      await dispatchesAfter(() => ds.deleteMessages('t-1', ['m-1']))
    })

    it('does NOT dispatch after fetchMessages', async () => {
      api.fetchMessages.mockResolvedValue(successResult({ messages: [], blocks: [] }))
      await doesNotDispatchAfter(() => ds.fetchMessages('t-1'))
    })

    it('does NOT dispatch after getRawTopic', async () => {
      api.getRawTopic.mockResolvedValue(successResult(null))
      await doesNotDispatchAfter(() => ds.getRawTopic('t-1'))
    })

    it('does NOT dispatch after topicExists', async () => {
      api.topicExists.mockResolvedValue(successResult(true))
      await doesNotDispatchAfter(() => ds.topicExists('t-1'))
    })

    it('does NOT dispatch after ensureTopic', async () => {
      api.ensureTopic.mockResolvedValue(successResult(null))
      await doesNotDispatchAfter(() => ds.ensureTopic('t-1'))
    })

    it('does NOT dispatch after updateBlocks', async () => {
      api.updateBlocks.mockResolvedValue(successResult(null))
      await doesNotDispatchAfter(() => ds.updateBlocks([]))
    })

    it('does NOT dispatch after updateSingleBlock', async () => {
      api.updateSingleBlock.mockResolvedValue(successResult(null))
      await doesNotDispatchAfter(() => ds.updateSingleBlock('b-1', {} as any))
    })

    it('does NOT dispatch after bulkAddBlocks', async () => {
      api.bulkAddBlocks.mockResolvedValue(successResult(null))
      await doesNotDispatchAfter(() => ds.bulkAddBlocks([]))
    })

    it('does NOT dispatch after deleteBlocks', async () => {
      api.deleteBlocks.mockResolvedValue(successResult({ affectedFileIds: [], remainingReferenceCounts: {} }))
      await doesNotDispatchAfter(() => ds.deleteBlocks(['b-1']))
    })

    it('does NOT dispatch when operation throws', async () => {
      api.appendMessage.mockResolvedValue(failureResult('ERR', 'fail'))
      mockDispatch.mockClear()
      try {
        await ds.appendMessage('t-1', { id: 'm-1' } as any, [])
      } catch {
        // expected
      }
      expect(mockDispatch).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Structural: no file-count methods
  // =========================================================================

  describe('structural: no file-count methods', () => {
    it('does not have updateFileCount method', () => {
      expect((ds as any).updateFileCount).toBeUndefined()
    })

    it('does not have updateFileCounts method', () => {
      expect((ds as any).updateFileCounts).toBeUndefined()
    })
  })

  // =========================================================================
  // Constructor / API resolution (chatImport isolation fix)
  //
  // Regression: constructing the data source inside an isolated renderer that
  // does NOT expose the ordinary preload bridge (e.g. chatImport exposes only
  // window.chatImport) must not throw. The bridge is resolved lazily at
  // method-call time, and a missing bridge fails loudly with a deterministic
  // error only when an actual SQLite method is invoked.
  // =========================================================================

  describe('constructor / API resolution (chatImport isolation)', () => {
    // renderer.setup.ts stubs globalThis.api (jsdom: window === globalThis).
    // Capture that exact stub and restore it after every test so sibling
    // suites stay isolated from window.api mutations.
    const setupWindowApi = (window as any).api

    afterEach(() => {
      ;(window as any).api = setupWindowApi
    })

    it('constructs successfully when window.api is absent (no injection)', () => {
      ;(window as any).api = undefined
      expect(() => new SqliteMessageDataSource()).not.toThrow()
    })

    it('constructs successfully when window.api exists but has no chatDb', () => {
      ;(window as any).api = { file: {} }
      expect(() => new SqliteMessageDataSource()).not.toThrow()
    })

    it('throws the clear unavailable-API error only when a method is called', async () => {
      ;(window as any).api = undefined
      const ds = new SqliteMessageDataSource()
      await expect(ds.fetchMessages('t-1')).rejects.toThrow(
        'ChatDb API unavailable: window.api.chatDb is not exposed in this window'
      )
    })

    it('throws the same deterministic error for every method', async () => {
      ;(window as any).api = undefined
      const ds = new SqliteMessageDataSource()
      const message = 'ChatDb API unavailable: window.api.chatDb is not exposed in this window'
      await expect(ds.fetchMessages('t-1')).rejects.toThrow(message)
      await expect(ds.topicExists('t-1')).rejects.toThrow(message)
      await expect(ds.appendMessage('t-1', { id: 'm-1' } as any, [])).rejects.toThrow(message)
    })

    it('never dispatches or falls back when the bridge is missing', async () => {
      ;(window as any).api = undefined
      mockDispatch.mockClear()
      const ds = new SqliteMessageDataSource()
      await expect(ds.softDeleteTopic('t-1')).rejects.toThrow('ChatDb API unavailable')
      expect(mockDispatch).not.toHaveBeenCalled()
      expect(api.updateMessage).not.toHaveBeenCalled()
    })

    it('resolves window.api.chatDb when no API is injected', async () => {
      const windowApi = makeApiSpy()
      ;(window as any).api = { chatDb: windowApi }
      const ds = new SqliteMessageDataSource()
      windowApi.fetchMessages.mockResolvedValue(successResult({ messages: [], blocks: [] }))
      await ds.fetchMessages('t-1')
      expect(windowApi.fetchMessages).toHaveBeenCalledOnce()
      expect(windowApi.fetchMessages).toHaveBeenCalledWith({ topicId: 't-1' })
    })

    it('prefers the injected API over window.api.chatDb', async () => {
      const injected = makeApiSpy()
      const windowApi = makeApiSpy()
      ;(window as any).api = { chatDb: windowApi }
      const ds = new SqliteMessageDataSource(injected)
      injected.fetchMessages.mockResolvedValue(successResult({ messages: [], blocks: [] }))
      await ds.fetchMessages('t-1')
      expect(injected.fetchMessages).toHaveBeenCalledOnce()
      expect(windowApi.fetchMessages).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Send-timing diagnostics (LOCK-001/003/004)
  // =========================================================================

  describe('append send-timing diagnostics', () => {
    let infoSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      resetDiagnosticCounters()
      infoSpy = vi.spyOn(loggerService, 'info').mockImplementation(() => {})
    })

    afterEach(() => {
      infoSpy.mockRestore()
      resetDiagnosticCounters()
    })

    const userMsg = { id: 'm-1', role: 'user', content: 'hi' } as any
    const userBlk = { id: 'b-1', messageId: 'm-1', type: 'main_text', content: 'hi' } as any

    it('omits diagnostics and timing logs when no send context is supplied', async () => {
      api.appendMessage.mockResolvedValue(successResult(null))
      await ds.appendMessage('topic-1', userMsg, [userBlk])

      const req = api.appendMessage.mock.calls[0][0]
      expect(req.diagnostics).toBeUndefined()
      const diagnosticLogs = infoSpy.mock.calls.filter((call) => String(call[0]).includes('[diagnostics]'))
      expect(diagnosticLogs).toHaveLength(0)
    })

    it('attaches correlationId + ordinal (1 then 2) for the two appends of one send', async () => {
      api.appendMessage.mockResolvedValue(successResult(null))
      const sendContext = createSendDiagnosticsContext()

      await ds.appendMessage('topic-1', userMsg, [userBlk], undefined, sendContext)
      await ds.appendMessage('topic-1', { ...userMsg, id: 'm-2' }, [], undefined, sendContext)

      const firstReq = api.appendMessage.mock.calls[0][0]
      const secondReq = api.appendMessage.mock.calls[1][0]
      expect(firstReq.diagnostics).toEqual({ correlationId: sendContext.correlationId, ordinal: 1 })
      expect(secondReq.diagnostics).toEqual({ correlationId: sendContext.correlationId, ordinal: 2 })
    })

    it('keeps correlation ids and ordinals separate across overlapping sends (LOCK-004)', async () => {
      // Two sends (ctxA, ctxB) interleave their append IPC round trips; each
      // append must consume from its OWN context and never cross-attribute.
      let resolveA: (v: ChatDbResult<null>) => void
      let resolveB: (v: ChatDbResult<null>) => void
      const gateA = new Promise<ChatDbResult<null>>((r) => {
        resolveA = r
      })
      const gateB = new Promise<ChatDbResult<null>>((r) => {
        resolveB = r
      })
      api.appendMessage.mockReturnValueOnce(gateA).mockReturnValueOnce(gateB).mockResolvedValue(successResult(null))

      const ctxA = createSendDiagnosticsContext()
      const ctxB = createSendDiagnosticsContext()

      const pA1 = ds.appendMessage('topic-1', { ...userMsg, id: 'a1' }, [], undefined, ctxA)
      const pB1 = ds.appendMessage('topic-1', { ...userMsg, id: 'b1' }, [], undefined, ctxB)
      const pB2 = ds.appendMessage('topic-1', { ...userMsg, id: 'b2' }, [], undefined, ctxB)
      const pA2 = ds.appendMessage('topic-1', { ...userMsg, id: 'a2' }, [], undefined, ctxA)

      resolveA!(successResult(null))
      resolveB!(successResult(null))
      await Promise.all([pA1, pB1, pB2, pA2])

      const diags = api.appendMessage.mock.calls.map((c) => c[0].diagnostics)
      expect(diags[0]).toEqual({ correlationId: ctxA.correlationId, ordinal: 1 })
      expect(diags[1]).toEqual({ correlationId: ctxB.correlationId, ordinal: 1 })
      expect(diags[2]).toEqual({ correlationId: ctxB.correlationId, ordinal: 2 })
      expect(diags[3]).toEqual({ correlationId: ctxA.correlationId, ordinal: 2 })
      // The two correlation ids are distinct.
      expect(ctxA.correlationId).not.toBe(ctxB.correlationId)
    })

    it('emits bounded stage logs whose correlation metadata matches the request diagnostics', async () => {
      api.appendMessage.mockResolvedValue(successResult(null))
      const sendContext = createSendDiagnosticsContext()

      await ds.appendMessage('topic-1', userMsg, [userBlk], undefined, sendContext)

      const req = api.appendMessage.mock.calls[0][0]
      const diagCalls = infoSpy.mock.calls.filter((call) => String(call[0]).includes('[diagnostics]'))
      expect(diagCalls.length).toBeGreaterThanOrEqual(3)
      const stages = diagCalls.map((call) => String(call[0]).replace('[diagnostics] ', ''))
      expect(stages).toContain('renderer.append.serialize')
      expect(stages).toContain('renderer.append.ipc')
      expect(stages).toContain('renderer.append.total')

      for (const call of diagCalls) {
        const data = call[1] as Record<string, unknown>
        expect(data.correlationId).toBe(req.diagnostics?.correlationId)
        expect(data.ordinal).toBe(req.diagnostics?.ordinal)
        expect(data.ok).toBe(true)
        expect(typeof data.durationMs).toBe('number')
        // Never logs message content or raw request objects. Exclude the
        // intentionally opaque correlation metadata so content checks cannot
        // collide with a generated correlation id.
        const payload = Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'correlationId'))
        expect(JSON.stringify(payload)).not.toContain(userMsg.content)
        expect(JSON.stringify(payload)).not.toContain(userMsg.id)
        expect(payload).not.toHaveProperty('content')
        expect(payload).not.toHaveProperty('message')
        expect(payload).not.toHaveProperty('blocks')
        expect(payload).not.toHaveProperty('request')
      }
    })

    it('logs ok=false and propagates transport rejection without replacing it', async () => {
      const transportError = new Error('IPC transport failed')
      api.appendMessage.mockRejectedValue(transportError)
      const sendContext = createSendDiagnosticsContext()

      await expect(ds.appendMessage('topic-1', userMsg, [userBlk], undefined, sendContext)).rejects.toThrow(
        'IPC transport failed'
      )

      const diagCalls = infoSpy.mock.calls.filter((call) => String(call[0]).includes('[diagnostics]'))
      const ipcFail = diagCalls.find((call) => String(call[0]).includes('renderer.append.ipc'))
      expect(ipcFail).toBeDefined()
      expect((ipcFail![1] as Record<string, unknown>).ok).toBe(false)
    })

    it('logs ok=false on structured failure and still throws ChatDbResultError', async () => {
      api.appendMessage.mockResolvedValue(failureResult('ERR_STORAGE', 'db failed'))
      const sendContext = createSendDiagnosticsContext()

      await expect(ds.appendMessage('topic-1', userMsg, [userBlk], undefined, sendContext)).rejects.toThrow(
        ChatDbResultError
      )

      const diagCalls = infoSpy.mock.calls.filter((call) => String(call[0]).includes('[diagnostics]'))
      const ipcFail = diagCalls.find((call) => String(call[0]).includes('renderer.append.ipc'))
      expect(ipcFail).toBeDefined()
      expect((ipcFail![1] as Record<string, unknown>).ok).toBe(false)
      // No success total log after a failed append.
      expect(diagCalls.some((call) => String(call[0]).includes('renderer.append.total'))).toBe(false)
    })

    it('bounds volume to the first few sends per stage (LOCK-003)', async () => {
      api.appendMessage.mockResolvedValue(successResult(null))
      const sendContext = createSendDiagnosticsContext()
      // 12 appends (6 sends) → only the first 6 per stage are logged.
      for (let i = 0; i < 12; i++) {
        await ds.appendMessage('topic-1', { ...userMsg, id: `m-${i}` }, [], undefined, sendContext)
      }
      const serializeLogs = infoSpy.mock.calls.filter((call) => String(call[0]).includes('renderer.append.serialize'))
      expect(serializeLogs.length).toBeLessThanOrEqual(6)
    })

    it('a later uninstrumented append is never attributed to a prior send context', async () => {
      api.appendMessage.mockResolvedValue(successResult(null))
      const sendContext = createSendDiagnosticsContext()
      await ds.appendMessage('topic-1', userMsg, [userBlk], undefined, sendContext)
      // Same caller, no context → no diagnostics, no attribution.
      await ds.appendMessage('topic-1', { ...userMsg, id: 'm-2' }, [])

      const secondReq = api.appendMessage.mock.calls[1][0]
      expect(secondReq.diagnostics).toBeUndefined()
    })
  })
})
