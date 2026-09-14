import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it, vi } from 'vitest'

import { chooseNavigationWindow, resolveMessageNavigation, runMessageNavigationTransaction } from '../messageNavigation'
import {
  buildNavigationAroundRequest,
  ensureMessageLoaded,
  NAVIGATION_LOADER_AFTER,
  NAVIGATION_LOADER_BEFORE
} from '../messageNavigationLoader'
import { createTargetMessageWindow } from '../messageWindow'

const msg = (id: string, sortOrder?: number, role: Message['role'] = 'user'): Message => ({
  id,
  role,
  assistantId: 'assistant',
  topicId: 'topic-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  status: role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS,
  blocks: [],
  ...(sortOrder !== undefined ? { sortOrder } : {})
})

const blockFor = (messageId: string, n: number) => ({
  id: `block-${n}`,
  messageId,
  type: 'main_text',
  content: `content ${n}`
})

const makeWindowResponse = (
  request: { topicId: string; anchorMessageId: string; before: number; after: number },
  messages: Message[],
  blocks: unknown[] = []
) => ({
  messages,
  blocks,
  window: {
    kind: 'around' as const,
    completeness: 'window' as const,
    topicId: request.topicId,
    anchorMessageId: request.anchorMessageId,
    requested: { before: request.before, after: request.after },
    firstMessageId: messages.length > 0 ? messages[0].id : null,
    lastMessageId: messages.length > 0 ? messages[messages.length - 1].id : null,
    returnedCount: messages.length,
    hasMoreBefore: false,
    hasMoreAfter: false
  }
})

const notFoundError = (code: string) => {
  const err = new Error(`missing ${code}`) as Error & { code: string; name: string }
  err.code = code
  // Mimic ChatDbResultError shape structurally (code contract, no heavy import).
  err.name = 'ChatDbResultError'
  return err
}

describe('messageNavigationLoader', () => {
  it('uses canonical around quotas before=10 after=19', () => {
    expect(NAVIGATION_LOADER_BEFORE).toBe(10)
    expect(NAVIGATION_LOADER_AFTER).toBe(19)
    const req = buildNavigationAroundRequest('topic-1', 'm-5')
    expect(req).toEqual({ kind: 'around', topicId: 'topic-1', anchorMessageId: 'm-5', before: 10, after: 19 })
  })

  it('resident fast path performs zero reads', async () => {
    const existing = [msg('m-1', 1), msg('m-2', 2)]
    const read = vi.fn(
      async () =>
        makeWindowResponse(
          { topicId: 'topic-1', anchorMessageId: 'm-1', before: 10, after: 19 },
          existing as any
        ) as any
    )
    const result = await ensureMessageLoaded('topic-1', 'm-1', {
      getExistingMessages: () => existing,
      readAroundWindow: read
    })
    expect(result).toEqual({ status: 'resident' })
    expect(read).not.toHaveBeenCalled()
  })

  it('missing target issues one around request anchored at target', async () => {
    const existing = [msg('m-30', 30), msg('m-31', 31)]
    const incoming = [msg('m-5', 5), msg('m-6', 6)]
    const read = vi.fn(
      async () =>
        makeWindowResponse({ topicId: 'topic-1', anchorMessageId: 'm-5', before: 10, after: 19 }, incoming as any, [
          blockFor('m-5', 5)
        ]) as any
    )
    const result = await ensureMessageLoaded('topic-1', 'm-5', {
      getExistingMessages: () => existing,
      readAroundWindow: read
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith({
      kind: 'around',
      topicId: 'topic-1',
      anchorMessageId: 'm-5',
      before: 10,
      after: 19
    })
    expect(result.status).toBe('loaded')
  })

  it('disjoint union is ordered without duplicates and contains target', async () => {
    const existing = Array.from({ length: 5 }, (_, i) => msg(`m-${30 + i}`, 30 + i))
    const incoming = Array.from({ length: 5 }, (_, i) => msg(`m-${i}`, i))
    const read = vi.fn(
      async () =>
        makeWindowResponse(
          { topicId: 'topic-1', anchorMessageId: 'm-2', before: 10, after: 19 },
          incoming as any
        ) as any
    )
    const result = await ensureMessageLoaded('topic-1', 'm-2', {
      getExistingMessages: () => existing,
      readAroundWindow: read
    })
    expect(result.status).toBe('loaded')
    if (result.status !== 'loaded') return
    const ids = result.messages.map((m) => m.id)
    expect(ids).toContain('m-2')
    for (const e of existing) expect(ids).toContain(e.id)
    for (const inc of incoming) expect(ids).toContain(inc.id)
    expect(new Set(ids).size).toBe(ids.length)
    const orders = result.messages.map((m) => (m as any).sortOrder as number)
    for (let i = 1; i < orders.length; i++) expect(orders[i]).toBeGreaterThan(orders[i - 1])
  })

  it('overlapping around window for a missing target unions without duplicates', async () => {
    // Existing lacks m-9 but shares neighbours with the around window.
    // Non-resident targets always use the canonical sorted union.
    const tail = [msg('m-6', 6), msg('m-7', 7)]
    const windowAroundMissing = [msg('m-7', 7), msg('m-8', 8), msg('m-9', 9)]
    const read = vi.fn(
      async () =>
        makeWindowResponse(
          { topicId: 'topic-1', anchorMessageId: 'm-9', before: 10, after: 19 },
          windowAroundMissing as any
        ) as any
    )
    const loaded = await ensureMessageLoaded('topic-1', 'm-9', {
      getExistingMessages: () => tail,
      readAroundWindow: read
    })
    expect(loaded.status).toBe('loaded')
    if (loaded.status !== 'loaded') return
    const ids = loaded.messages.map((m) => m.id)
    expect(ids).toContain('m-9')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('malformed/topic/kind/anchor mismatch fails closed as error (retryable)', async () => {
    const existing: Message[] = []
    const goodIncoming = [msg('m-1', 1)]

    const malformed = {
      messages: goodIncoming,
      blocks: [],
      window: {
        kind: 'around',
        completeness: 'whole-topic',
        topicId: 'topic-1',
        anchorMessageId: 'm-1',
        requested: { before: 10, after: 19 },
        firstMessageId: 'm-1',
        lastMessageId: 'm-1',
        returnedCount: 1,
        hasMoreBefore: false,
        hasMoreAfter: false
      }
    }
    expect(
      await ensureMessageLoaded('topic-1', 'm-1', {
        getExistingMessages: () => existing,
        readAroundWindow: vi.fn(async () => malformed as any)
      })
    ).toEqual({ status: 'error' })

    const wrongTopic = makeWindowResponse(
      { topicId: 'other', anchorMessageId: 'm-1', before: 10, after: 19 },
      goodIncoming as any
    )
    expect(
      await ensureMessageLoaded('topic-1', 'm-1', {
        getExistingMessages: () => existing,
        readAroundWindow: vi.fn(async () => wrongTopic as any)
      })
    ).toEqual({ status: 'error' })

    const wrongAnchor = makeWindowResponse(
      { topicId: 'topic-1', anchorMessageId: 'm-9', before: 10, after: 19 },
      goodIncoming as any
    )
    expect(
      await ensureMessageLoaded('topic-1', 'm-1', {
        getExistingMessages: () => existing,
        readAroundWindow: vi.fn(async () => wrongAnchor as any)
      })
    ).toEqual({ status: 'error' })

    const missingAnchorInMessages = makeWindowResponse(
      { topicId: 'topic-1', anchorMessageId: 'm-1', before: 10, after: 19 },
      [msg('m-2', 2)] as any
    )
    expect(
      await ensureMessageLoaded('topic-1', 'm-1', {
        getExistingMessages: () => existing,
        readAroundWindow: vi.fn(async () => missingAnchorInMessages as any)
      })
    ).toEqual({ status: 'error' })
  })

  it('explicit NOT_FOUND family maps to not-found', async () => {
    for (const code of ['NOT_FOUND', 'ERR_NOT_FOUND', 'TOPIC_NOT_FOUND']) {
      const result = await ensureMessageLoaded('topic-1', 'm-1', {
        getExistingMessages: () => [],
        readAroundWindow: vi.fn(async () => {
          throw notFoundError(code)
        })
      })
      expect(result).toEqual({ status: 'not-found' })
    }
  })

  it('transport/unknown errors map to error (preserve pending)', async () => {
    const transport = new Error('IPC transport failed')
    expect(
      await ensureMessageLoaded('topic-1', 'm-1', {
        getExistingMessages: () => [],
        readAroundWindow: vi.fn(async () => {
          throw transport
        })
      })
    ).toEqual({ status: 'error' })

    const unknownCode = Object.assign(new Error('boom'), { code: 'VALIDATION_ERROR' })
    expect(
      await ensureMessageLoaded('topic-1', 'm-1', {
        getExistingMessages: () => [],
        readAroundWindow: vi.fn(async () => {
          throw unknownCode
        })
      })
    ).toEqual({ status: 'error' })
  })

  it('stale before fetch cancels with zero reads', async () => {
    const read = vi.fn(
      async () =>
        makeWindowResponse({ topicId: 'topic-1', anchorMessageId: 'm-1', before: 10, after: 19 }, [
          msg('m-1', 1)
        ] as any) as any
    )
    const result = await ensureMessageLoaded('topic-1', 'm-1', {
      getExistingMessages: () => [],
      readAroundWindow: read,
      isStaleBeforeFetch: () => true
    })
    expect(result).toEqual({ status: 'cancelled' })
    expect(read).not.toHaveBeenCalled()
  })

  it('stale after fetch cancels without merge output', async () => {
    const read = vi.fn(
      async () =>
        makeWindowResponse(
          { topicId: 'topic-1', anchorMessageId: 'm-1', before: 10, after: 19 },
          [msg('m-1', 1)] as any,
          [blockFor('m-1', 1)]
        ) as any
    )
    const result = await ensureMessageLoaded('topic-1', 'm-1', {
      getExistingMessages: () => [],
      readAroundWindow: read,
      isStaleAfterFetch: () => true
    })
    expect(result).toEqual({ status: 'cancelled' })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('ensure then transaction succeeds from merged projection when target starts outside loaded messages', async () => {
    const loadedTail = Array.from({ length: 5 }, (_, i) => msg(`m-${30 + i}`, 30 + i))
    const incoming = [msg('m-4', 4), msg('m-5', 5), msg('m-6', 6)]
    const read = vi.fn(
      async () =>
        makeWindowResponse(
          { topicId: 'topic-1', anchorMessageId: 'm-5', before: 10, after: 19 },
          incoming as any
        ) as any
    )
    const ensured = await ensureMessageLoaded('topic-1', 'm-5', {
      getExistingMessages: () => loadedTail,
      readAroundWindow: read
    })
    expect(ensured.status).toBe('loaded')
    if (ensured.status !== 'loaded') return
    expect(ensured.messages.some((m) => m.id === 'm-5')).toBe(true)

    // The Messages navigate path publishes merged messages+blocks, then runs
    // the existing transaction which resolves from the latest projection.
    const merged = ensured.messages
    const resolved = resolveMessageNavigation(merged, { kind: 'message', targetId: 'm-5', source: 'event' })
    expect(resolved).not.toBeNull()

    const effectiveWindow = createTargetMessageWindow(merged, 'm-5', 10, 19)
    const result = await runMessageNavigationTransaction(
      { kind: 'message', targetId: 'm-5', source: 'event' },
      {
        begin: async () => true,
        isCurrent: () => true,
        cancelLoadsAndTimers: () => {},
        resolve: (intent) => resolveMessageNavigation(merged, intent),
        prepareWindow: (r) => chooseNavigationWindow(merged, effectiveWindow, r, 10),
        applyWindow: async () => true,
        getTargetStatus: () => 'visible',
        revealTarget: async () => {},
        settleDom: async () => {},
        beginProgrammaticScroll: async () => true,
        scroll: () => {},
        finish: () => {},
        cancel: () => {}
      }
    )
    expect(result).toBe('success')
  })
})
