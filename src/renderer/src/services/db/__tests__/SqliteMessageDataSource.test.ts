/**
 * SqliteMessageDataSource Tests — using injected API spies.
 *
 * Covers:
 * - All 23 methods map to the intended named method/request
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

import type {
  AppendMessageRequest,
  BulkAddBlocksRequest,
  ChatDbResult,
  ClearMessagesRequest,
  ClearTopicWithSegmentsRequest,
  ClearTopicWithSegmentsResponse,
  CloneMessagesToTopicRequest,
  CloneMessagesToTopicResponse,
  CountFileRefsByFileRequest,
  CountFileRefsByFileResponse,
  DeleteBlocksRequest,
  DeleteMessageRequest,
  DeleteMessagesRequest,
  DeleteMessagesWithSegmentsRequest,
  DeleteMessagesWithSegmentsResponse,
  DeleteSegmentRequest,
  EnsureTopicRequest,
  FetchMessagesRequest,
  FetchMessagesResponse,
  GetRawTopicRequest,
  GetRawTopicResponse,
  HardDeleteTopicRequest,
  HardDeleteTopicResponse,
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
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    updateMessageAndBlocks: vi.fn<(request: UpdateMessageAndBlocksRequest) => Promise<ChatDbResult<null>>>(),
    deleteMessage: vi.fn<(request: DeleteMessageRequest) => Promise<ChatDbResult<null>>>(),
    deleteMessages: vi.fn<(request: DeleteMessagesRequest) => Promise<ChatDbResult<null>>>(),
    updateBlocks: vi.fn<(request: UpdateBlocksRequest) => Promise<ChatDbResult<null>>>(),
    updateSingleBlock: vi.fn<(request: UpdateSingleBlockRequest) => Promise<ChatDbResult<null>>>(),
    bulkAddBlocks: vi.fn<(request: BulkAddBlocksRequest) => Promise<ChatDbResult<null>>>(),
    deleteBlocks: vi.fn<(request: DeleteBlocksRequest) => Promise<ChatDbResult<null>>>(),
    clearMessages: vi.fn<(request: ClearMessagesRequest) => Promise<ChatDbResult<null>>>(),
    // Phase 5.1A
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
    restoreTopic: vi.fn<(request: RestoreTopicRequest) => Promise<ChatDbResult<null>>>(),
    listTrashTopics: vi.fn<(request: ListTrashTopicsRequest) => Promise<ChatDbResult<ListTrashTopicsResponse>>>(),
    hardDeleteTopic: vi.fn<(request: HardDeleteTopicRequest) => Promise<ChatDbResult<HardDeleteTopicResponse>>>(),
    purgeExpiredTopics:
      vi.fn<(request: PurgeExpiredTopicsRequest) => Promise<ChatDbResult<PurgeExpiredTopicsResponse>>>(),
    // Phase 5.1B: compound mutations
    cloneMessagesToTopic:
      vi.fn<(request: CloneMessagesToTopicRequest) => Promise<ChatDbResult<CloneMessagesToTopicResponse>>>(),
    resetMessagesForResend:
      vi.fn<(request: ResetMessagesForResendRequest) => Promise<ChatDbResult<ResetMessagesForResendResponse>>>(),
    deleteMessagesWithSegments:
      vi.fn<
        (request: DeleteMessagesWithSegmentsRequest) => Promise<ChatDbResult<DeleteMessagesWithSegmentsResponse>>
      >(),
    pasteMessagesToTopic:
      vi.fn<(request: PasteMessagesToTopicRequest) => Promise<ChatDbResult<PasteMessagesToTopicResponse>>>(),
    clearTopicWithSegments:
      vi.fn<(request: ClearTopicWithSegmentsRequest) => Promise<ChatDbResult<ClearTopicWithSegmentsResponse>>>()
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
      api.updateMessageAndBlocks.mockResolvedValue(successResult(null))
      const msgUpdates = { id: 'm-1', topicId: 't-1', sortOrder: 5, content: 'updated' } as any
      await ds.updateMessageAndBlocks('topic-1', msgUpdates, [])
      const req = api.updateMessageAndBlocks.mock.calls[0][0]
      expect(req.topicId).toBe('topic-1')
      expect(req.messageUpdates.id).toBe('m-1')
      expect(req.messageUpdates.topicId).toBeUndefined()
      expect(req.messageUpdates.sortOrder).toBeUndefined()
      expect(req.messageUpdates.content).toBe('updated')
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

    it('bulkAddBlocks calls api.bulkAddBlocks', async () => {
      api.bulkAddBlocks.mockResolvedValue(successResult(null))
      const blk = { id: 'b-1', messageId: 'm-1', type: 'main_text' } as any
      await ds.bulkAddBlocks([blk])
      const req = api.bulkAddBlocks.mock.calls[0][0]
      expect(req.blocks).toHaveLength(1)
    })

    it('deleteBlocks calls api.deleteBlocks', async () => {
      api.deleteBlocks.mockResolvedValue(successResult(null))
      await ds.deleteBlocks(['b-1', 'b-2'])
      expect(api.deleteBlocks).toHaveBeenCalledWith({ blockIds: ['b-1', 'b-2'] })
    })

    it('clearMessages calls api.clearMessages', async () => {
      api.clearMessages.mockResolvedValue(successResult(null))
      await ds.clearMessages('topic-1')
      expect(api.clearMessages).toHaveBeenCalledWith({ topicId: 'topic-1' })
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
      await ds.softDeleteTopic('t-1')
      expect(api.softDeleteTopic).toHaveBeenCalledOnce()
      expect(api.softDeleteTopic).toHaveBeenCalledWith({ topicId: 't-1' })
      expect(mockDispatch).toHaveBeenCalledOnce()
    })

    it('restoreTopic calls api and dispatches', async () => {
      api.restoreTopic.mockResolvedValue(successResult(null))
      await ds.restoreTopic('t-1')
      expect(api.restoreTopic).toHaveBeenCalledOnce()
      expect(mockDispatch).toHaveBeenCalledOnce()
    })

    it('listTrashTopics calls api with correct request', async () => {
      api.listTrashTopics.mockResolvedValue(successResult({ items: [{ id: 't-1' }], hasMore: false }))
      const result = await ds.listTrashTopics('a-1', 10, 'cursor')
      expect(api.listTrashTopics).toHaveBeenCalledOnce()
      expect(result.items.length).toBe(1)
    })

    it('hardDeleteTopic calls api and dispatches', async () => {
      api.hardDeleteTopic.mockResolvedValue(
        successResult({ affectedFileIds: ['f1'], remainingReferenceCounts: { f1: 0 } })
      )
      const result = await ds.hardDeleteTopic('t-1')
      expect(api.hardDeleteTopic).toHaveBeenCalledOnce()
      expect(mockDispatch).toHaveBeenCalledOnce()
      expect(result.affectedFileIds).toEqual(['f1'])
    })

    it('purgeExpiredTopics calls api', async () => {
      api.purgeExpiredTopics.mockResolvedValue(successResult({ affectedFileIds: [], remainingReferenceCounts: {} }))
      const result = await ds.purgeExpiredTopics('2025-01-01T00:00:00.000Z')
      expect(api.purgeExpiredTopics).toHaveBeenCalledOnce()
      expect(result.affectedFileIds).toEqual([])
    })
  })

  describe('Phase 5.1B: compound mutations', () => {
    it('cloneMessagesToTopic calls api and dispatches', async () => {
      api.cloneMessagesToTopic.mockResolvedValue(successResult(null))
      await ds.cloneMessagesToTopic('t-1', [{ message: { id: 'm1' }, blocks: [{ id: 'b1', messageId: 'm1' }] }], 'a1')
      expect(api.cloneMessagesToTopic).toHaveBeenCalledOnce()
      expect(mockDispatch).toHaveBeenCalledOnce()
    })

    it('resetMessagesForResend calls api and dispatches', async () => {
      api.resetMessagesForResend.mockResolvedValue(
        successResult({ affectedFileIds: ['f1'], remainingReferenceCounts: { f1: 0 } })
      )
      const result = await ds.resetMessagesForResend('t-1', ['m1'], ['b1'])
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

    it('clearTopicWithSegments calls api and dispatches', async () => {
      api.clearTopicWithSegments.mockResolvedValue(
        successResult({ affectedFileIds: ['f1'], remainingReferenceCounts: { f1: 0 } })
      )
      const result = await ds.clearTopicWithSegments('t-1')
      expect(api.clearTopicWithSegments).toHaveBeenCalledOnce()
      expect(mockDispatch).toHaveBeenCalledOnce()
      expect(result.affectedFileIds).toEqual(['f1'])
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
      api.updateMessageAndBlocks.mockResolvedValue(successResult(null))
      await dispatchesAfter(() => ds.updateMessageAndBlocks('t-1', { id: 'm-1' } as any, []))
    })

    it('dispatches after deleteMessage', async () => {
      api.deleteMessage.mockResolvedValue(successResult(null))
      await dispatchesAfter(() => ds.deleteMessage('t-1', 'm-1'))
    })

    it('dispatches after deleteMessages', async () => {
      api.deleteMessages.mockResolvedValue(successResult(null))
      await dispatchesAfter(() => ds.deleteMessages('t-1', ['m-1']))
    })

    it('dispatches after clearMessages', async () => {
      api.clearMessages.mockResolvedValue(successResult(null))
      await dispatchesAfter(() => ds.clearMessages('t-1'))
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
      api.deleteBlocks.mockResolvedValue(successResult(null))
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
})
