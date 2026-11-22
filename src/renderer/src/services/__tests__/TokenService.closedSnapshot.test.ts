/**
 * Closed-snapshot history token estimation — snapshot decides block content.
 *
 * Validates that `estimateHistoryTokens`/`estimateMessageUsage` read text,
 * thinking, file, and image blocks exclusively from the supplied snapshot
 * when one is provided: a store/snapshot content conflict resolves to the
 * snapshot, a block missing from the snapshot counts as missing, and a
 * later store change cannot move an already-paired estimate. The legacy
 * path (no snapshot) keeps the store-backed behavior unchanged.
 *
 * tokenx is mocked to 1 char = 1 token so expectations are exact.
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { resetSendableFileTextCache } from '@renderer/aiCore/prepareParams/sendableFileText'
import { IMAGE_FALLBACK_TOKENS, resetLocalTokenEstimatorCache } from '@renderer/services/LocalTokenEstimator'
import { estimateHistoryTokens, estimateMessageUsage } from '@renderer/services/TokenService'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import { type Assistant, FILE_TYPE } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockType, UserMessageStatus } from '@renderer/types/newMessage'
import { createSnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock store for block selectors
// ---------------------------------------------------------------------------
const reducer = combineReducers({
  messageBlocks: messageBlocksSlice.reducer
})

const createMockStore = () =>
  configureStore({
    reducer,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false })
  })

let mockStore: ReturnType<typeof createMockStore>

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => mockStore.getState(),
    dispatch: (action: unknown) => mockStore.dispatch(action as never)
  }
}))

// Mock tokenx so tests are deterministic (1 char ≈ 1 token)
vi.mock('tokenx', () => ({
  estimateTokenCount: (text: string) => text.length
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const putBlock = (block: Record<string, unknown>) => {
  mockStore.dispatch(messageBlocksSlice.actions.upsertOneBlock(block as never))
}

const makeMsg = (id: string, blockIds: string[], role: Message['role'] = 'user'): Message =>
  ({
    id,
    role,
    assistantId: 'assistant-1',
    topicId: 'topic-1',
    createdAt: '2026-07-19T00:00:00.000Z',
    status: role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS,
    blocks: blockIds
  }) as Message

const textBlock = (id: string, messageId: string, content: string) => ({
  id,
  type: MessageBlockType.MAIN_TEXT,
  content,
  messageId
})

const makeAssistant = (prompt = 'system prompt'): Assistant =>
  ({ id: 'a1', prompt, settings: {} }) as unknown as Assistant

const PROMPT_TOKENS = 'system prompt'.length

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('estimateHistoryTokens closed snapshot', () => {
  beforeEach(() => {
    mockStore = createMockStore()
    resetLocalTokenEstimatorCache()
    resetSendableFileTextCache()
    vi.clearAllMocks()
  })

  it('text conflict resolves to the snapshot; legacy reads the store', async () => {
    // Store holds live content; the message references the same block id.
    putBlock({ ...textBlock('b1', 'm1', 'store-content'), id: 'b1' })
    const m1 = makeMsg('m1', ['b1'])
    const assistant = makeAssistant()

    const snapshot = createSnapshotBlockMap([{ ...textBlock('b1', 'm1', 'snap') } as any])

    // Closed: 'snap ' (content + join space) = 5 text tokens + prompt.
    const closed = await estimateHistoryTokens(assistant, [m1], { snapshotBlocks: snapshot })
    expect(closed).toBe(5 + PROMPT_TOKENS)

    // Legacy: 'store-content ' = 14 text tokens + prompt.
    const legacy = await estimateHistoryTokens(assistant, [m1])
    expect(legacy).toBe(14 + PROMPT_TOKENS)
  })

  it('thinking content resolves from the snapshot', async () => {
    putBlock({ ...textBlock('b1', 'm1', 'store-main'), id: 'b1' })
    putBlock({ id: 't1', type: MessageBlockType.THINKING, content: 'store-think', messageId: 'm1' })
    const m1 = makeMsg('m1', ['b1', 't1'])
    const assistant = makeAssistant()

    const snapshot = createSnapshotBlockMap([
      { ...textBlock('b1', 'm1', 'hi') } as any,
      { id: 't1', type: MessageBlockType.THINKING, content: 'deep', messageId: 'm1' } as any
    ])

    // Closed: 'hi deep' = 7 tokens + prompt.
    const closed = await estimateHistoryTokens(assistant, [m1], { snapshotBlocks: snapshot })
    expect(closed).toBe(7 + PROMPT_TOKENS)

    // Legacy: 'store-main store-think' = 22 tokens + prompt.
    const legacy = await estimateHistoryTokens(assistant, [m1])
    expect(legacy).toBe(22 + PROMPT_TOKENS)
  })

  it('TEXT file block falls back on file size from the snapshot, not the store', async () => {
    // Both files are pre-upload drafts (path does not resolve to storage), so
    // the shared text read rejects under jsdom and the bounded byte fallback
    // (size / 4) applies per file identity.
    const storeFile = {
      id: 'f1',
      ext: '.txt',
      type: FILE_TYPE.TEXT,
      size: 1000,
      origin_name: 'notes.txt',
      path: '/tmp/draft-abc.txt'
    }
    putBlock({ id: 'fb1', type: MessageBlockType.FILE, file: storeFile, messageId: 'm1' })
    const m1 = makeMsg('m1', ['fb1'])
    const assistant = makeAssistant()

    const snapshotFile = { ...storeFile, size: 100 }
    const snapshot = createSnapshotBlockMap([
      { id: 'fb1', type: MessageBlockType.FILE, file: snapshotFile, messageId: 'm1' } as any
    ])

    // Text part is the join space (1 token); file part is size/4.
    const closed = await estimateHistoryTokens(assistant, [m1], { snapshotBlocks: snapshot })
    expect(closed).toBe(1 + 25 + PROMPT_TOKENS)

    const legacy = await estimateHistoryTokens(assistant, [m1])
    expect(legacy).toBe(1 + 250 + PROMPT_TOKENS)
  })

  it('image block resolves url presence from the snapshot', async () => {
    // Store: bare IMAGE block (no url/file) counts 0 image tokens.
    putBlock({ id: 'ib1', type: MessageBlockType.IMAGE, messageId: 'm1' })
    const m1 = makeMsg('m1', ['ib1'])
    const assistant = makeAssistant()

    // Snapshot: same id with a remote url counts the fixed fallback.
    const snapshot = createSnapshotBlockMap([
      { id: 'ib1', type: MessageBlockType.IMAGE, url: 'https://e.com/a.png', messageId: 'm1' } as any
    ])

    expect(IMAGE_FALLBACK_TOKENS).toBe(765)
    const closed = await estimateHistoryTokens(assistant, [m1], { snapshotBlocks: snapshot })
    expect(closed).toBe(1 + IMAGE_FALLBACK_TOKENS + PROMPT_TOKENS)

    const legacy = await estimateHistoryTokens(assistant, [m1])
    expect(legacy).toBe(1 + PROMPT_TOKENS)
  })

  it('block missing from the snapshot counts as missing (empty text)', async () => {
    putBlock({ ...textBlock('b1', 'm1', 'store-content'), id: 'b1' })
    const m1 = makeMsg('m1', ['b1'])

    // Empty snapshot: no text found; content + reasoning join to a single space.
    const usage = await estimateMessageUsage(m1, { snapshotBlocks: new Map() })
    expect(usage.total_tokens).toBe(1)
  })

  it('no-snapshot legacy path equals the store-based estimate', async () => {
    putBlock({ ...textBlock('b1', 'm1', 'store-content'), id: 'b1' })
    const m1 = makeMsg('m1', ['b1'])

    const usage = await estimateMessageUsage(m1)
    expect(usage.total_tokens).toBe(14)
  })
})
