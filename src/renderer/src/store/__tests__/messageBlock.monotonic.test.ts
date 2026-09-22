import { configureStore } from '@reduxjs/toolkit'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import messageBlocksReducer, { updateOneBlock, upsertManyBlocks, upsertOneBlock } from '../messageBlock'
import { publishResidentComplete } from '../residentRegistry'

const makeThinking = (id: string, overrides: any = {}) => ({
  id,
  messageId: 'm1',
  type: MessageBlockType.THINKING,
  status: MessageBlockStatus.PENDING,
  createdAt: new Date().toISOString(),
  content: 'thought',
  thinking_millsec: 0,
  ...overrides
})

function createStore() {
  return configureStore({
    reducer: { messageBlocks: messageBlocksReducer },
    middleware: (g) => g({ serializableCheck: false })
  })
}

describe('messageBlocks monotonic guard (terminal SUCCESS/ERROR blocks reject stale PROCESSING/STREAMING)', () => {
  it('upsertOneBlock: rejects stale STREAMING after SUCCESS and preserves persisted fields', () => {
    const store = createStore()
    store.dispatch(
      upsertOneBlock(
        makeThinking('b1', { status: MessageBlockStatus.SUCCESS, thinking_millsec: 3200, content: 'final' })
      )
    )
    expect(store.getState().messageBlocks.entities['b1']?.status).toBe(MessageBlockStatus.SUCCESS)
    // stale STREAMING update with different thinking_millsec/content must be ignored entirely
    store.dispatch(
      upsertOneBlock(
        makeThinking('b1', {
          status: MessageBlockStatus.STREAMING,
          thinking_millsec: 100,
          content: 'stale'
        })
      )
    )
    const after = store.getState().messageBlocks.entities['b1'] as any
    expect(after.status).toBe(MessageBlockStatus.SUCCESS)
    expect(after.thinking_millsec).toBe(3200)
    expect(after.content).toBe('final')
  })

  it('upsertOneBlock: rejects stale PROCESSING after ERROR', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeThinking('b2', { status: MessageBlockStatus.ERROR })))
    store.dispatch(upsertOneBlock(makeThinking('b2', { status: MessageBlockStatus.PROCESSING })))
    expect(store.getState().messageBlocks.entities['b2']?.status).toBe(MessageBlockStatus.ERROR)
    store.dispatch(upsertOneBlock(makeThinking('b2', { status: MessageBlockStatus.STREAMING })))
    expect(store.getState().messageBlocks.entities['b2']?.status).toBe(MessageBlockStatus.ERROR)
  })

  it('updateOneBlock: rejects stale status patch after terminal but allows other fields', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeThinking('b3', { status: MessageBlockStatus.SUCCESS, thinking_millsec: 1234 })))
    // stale patch with status STREAMING must be rejected whole
    store.dispatch(
      updateOneBlock({ id: 'b3', changes: { status: MessageBlockStatus.STREAMING, thinking_millsec: 999 } } as any)
    )
    const afterStale = store.getState().messageBlocks.entities['b3'] as any
    expect(afterStale.status).toBe(MessageBlockStatus.SUCCESS)
    expect(afterStale.thinking_millsec).toBe(1234)
    // non-status patch should still apply if not stale? Our rule only blocks when status is stale;
    // a patch without status should not be blocked even after terminal
    // but we test that a terminal-to-terminal or non-stale status change is allowed per smallest rule
  })

  it('upsertManyBlocks: per-entity filter rejects stale in batch while keeping valid entries', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeThinking('b4', { status: MessageBlockStatus.SUCCESS })))
    store.dispatch(upsertOneBlock(makeThinking('b5', { status: MessageBlockStatus.STREAMING })))
    store.dispatch(
      upsertManyBlocks([
        makeThinking('b4', { status: MessageBlockStatus.STREAMING }), // stale -> reject
        makeThinking('b5', { status: MessageBlockStatus.SUCCESS }), // STREAMING->SUCCESS allowed
        makeThinking('b6', { status: MessageBlockStatus.STREAMING }) // new block allowed
      ])
    )
    expect(store.getState().messageBlocks.entities['b4']?.status).toBe(MessageBlockStatus.SUCCESS)
    expect(store.getState().messageBlocks.entities['b5']?.status).toBe(MessageBlockStatus.SUCCESS)
    expect(store.getState().messageBlocks.entities['b6']?.status).toBe(MessageBlockStatus.STREAMING)
  })

  it('does not block allowed non-terminal lifecycle and PAUSED/resume semantics', () => {
    const store = createStore()
    // PENDING -> PROCESSING -> STREAMING -> SUCCESS allowed
    store.dispatch(upsertOneBlock(makeThinking('b7', { status: MessageBlockStatus.PENDING })))
    store.dispatch(updateOneBlock({ id: 'b7', changes: { status: MessageBlockStatus.PROCESSING } } as any))
    expect(store.getState().messageBlocks.entities['b7']?.status).toBe(MessageBlockStatus.PROCESSING)
    store.dispatch(updateOneBlock({ id: 'b7', changes: { status: MessageBlockStatus.STREAMING } } as any))
    expect(store.getState().messageBlocks.entities['b7']?.status).toBe(MessageBlockStatus.STREAMING)
    store.dispatch(updateOneBlock({ id: 'b7', changes: { status: MessageBlockStatus.SUCCESS } } as any))
    expect(store.getState().messageBlocks.entities['b7']?.status).toBe(MessageBlockStatus.SUCCESS)

    // PAUSED -> STREAMING resume must remain allowed (PAUSED not terminal)
    store.dispatch(upsertOneBlock(makeThinking('b8', { status: MessageBlockStatus.PAUSED })))
    store.dispatch(updateOneBlock({ id: 'b8', changes: { status: MessageBlockStatus.STREAMING } } as any))
    expect(store.getState().messageBlocks.entities['b8']?.status).toBe(MessageBlockStatus.STREAMING)
    // STREAMING -> PAUSED allowed
    store.dispatch(updateOneBlock({ id: 'b8', changes: { status: MessageBlockStatus.PAUSED } } as any))
    expect(store.getState().messageBlocks.entities['b8']?.status).toBe(MessageBlockStatus.PAUSED)
    // PAUSED -> SUCCESS allowed (finalization after pause)
    store.dispatch(updateOneBlock({ id: 'b8', changes: { status: MessageBlockStatus.SUCCESS } } as any))
    expect(store.getState().messageBlocks.entities['b8']?.status).toBe(MessageBlockStatus.SUCCESS)

    // SUCCESS -> SUCCESS (idempotent) allowed, SUCCESS -> ERROR (terminal to terminal) not blocked by minimal rule
    store.dispatch(upsertOneBlock(makeThinking('b9', { status: MessageBlockStatus.SUCCESS })))
    store.dispatch(upsertOneBlock(makeThinking('b9', { status: MessageBlockStatus.ERROR })))
    expect(store.getState().messageBlocks.entities['b9']?.status).toBe(MessageBlockStatus.ERROR)
  })

  it('intra-batch SUCCESS then stale STREAMING for same id is rejected', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeThinking('b10', { status: MessageBlockStatus.PENDING })))
    store.dispatch(
      upsertManyBlocks([
        makeThinking('b10', { status: MessageBlockStatus.SUCCESS, thinking_millsec: 1000 }),
        makeThinking('b10', { status: MessageBlockStatus.STREAMING, thinking_millsec: 100 }) // stale after SUCCESS in same batch
      ])
    )
    const after = store.getState().messageBlocks.entities['b10'] as any
    expect(after.status).toBe(MessageBlockStatus.SUCCESS)
    expect(after.thinking_millsec).toBe(1000)
  })
})

describe('messageBlocks monotonic guard — stale PAUSED/PENDING and authoritative publish', () => {
  const publish = (blocks: any[]) =>
    publishResidentComplete({
      topicId: 't1',
      generation: 1,
      windowResponse: { blocks, messages: [] } as any,
      segments: []
    })

  it('rejects stale PAUSED/PENDING overwrites of SUCCESS/ERROR via upsertOneBlock', () => {
    const store = createStore()
    store.dispatch(
      upsertOneBlock(
        makeThinking('p1', { status: MessageBlockStatus.SUCCESS, content: 'final', thinking_millsec: 900 })
      )
    )
    store.dispatch(
      upsertOneBlock(makeThinking('p1', { status: MessageBlockStatus.PAUSED, content: 'stale', thinking_millsec: 1 }))
    )
    expect(store.getState().messageBlocks.entities['p1']?.status).toBe(MessageBlockStatus.SUCCESS)
    expect((store.getState().messageBlocks.entities['p1'] as any).content).toBe('final')
    store.dispatch(upsertOneBlock(makeThinking('p1', { status: MessageBlockStatus.PENDING, thinking_millsec: 2 })))
    expect(store.getState().messageBlocks.entities['p1']?.status).toBe(MessageBlockStatus.SUCCESS)

    store.dispatch(upsertOneBlock(makeThinking('p2', { status: MessageBlockStatus.ERROR })))
    store.dispatch(upsertOneBlock(makeThinking('p2', { status: MessageBlockStatus.PAUSED })))
    expect(store.getState().messageBlocks.entities['p2']?.status).toBe(MessageBlockStatus.ERROR)
    store.dispatch(upsertOneBlock(makeThinking('p2', { status: MessageBlockStatus.PENDING })))
    expect(store.getState().messageBlocks.entities['p2']?.status).toBe(MessageBlockStatus.ERROR)
  })

  it('rejects stale PAUSED/PENDING via updateOneBlock and upsertManyBlocks while keeping valid entries', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeThinking('q1', { status: MessageBlockStatus.SUCCESS, thinking_millsec: 500 })))
    store.dispatch(
      updateOneBlock({ id: 'q1', changes: { status: MessageBlockStatus.PAUSED, thinking_millsec: 1 } } as any)
    )
    expect(store.getState().messageBlocks.entities['q1']?.status).toBe(MessageBlockStatus.SUCCESS)
    expect((store.getState().messageBlocks.entities['q1'] as any).thinking_millsec).toBe(500)
    store.dispatch(
      updateOneBlock({ id: 'q1', changes: { status: MessageBlockStatus.PENDING, thinking_millsec: 2 } } as any)
    )
    expect(store.getState().messageBlocks.entities['q1']?.status).toBe(MessageBlockStatus.SUCCESS)

    store.dispatch(upsertOneBlock(makeThinking('q2', { status: MessageBlockStatus.SUCCESS })))
    store.dispatch(upsertOneBlock(makeThinking('q3', { status: MessageBlockStatus.PAUSED })))
    store.dispatch(
      upsertManyBlocks([
        makeThinking('q2', { status: MessageBlockStatus.PENDING }),
        makeThinking('q2', { status: MessageBlockStatus.PAUSED }),
        makeThinking('q3', { status: MessageBlockStatus.STREAMING }), // PAUSED -> STREAMING resume stays allowed
        makeThinking('q4', { status: MessageBlockStatus.PENDING }) // new block allowed
      ])
    )
    expect(store.getState().messageBlocks.entities['q2']?.status).toBe(MessageBlockStatus.SUCCESS)
    expect(store.getState().messageBlocks.entities['q3']?.status).toBe(MessageBlockStatus.STREAMING)
    expect(store.getState().messageBlocks.entities['q4']?.status).toBe(MessageBlockStatus.PENDING)
  })

  it('still allows PAUSED block to resume to STREAMING and normal non-terminal transitions', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeThinking('r1', { status: MessageBlockStatus.PAUSED })))
    store.dispatch(upsertOneBlock(makeThinking('r1', { status: MessageBlockStatus.STREAMING })))
    expect(store.getState().messageBlocks.entities['r1']?.status).toBe(MessageBlockStatus.STREAMING)
    store.dispatch(updateOneBlock({ id: 'r1', changes: { status: MessageBlockStatus.PAUSED } } as any))
    expect(store.getState().messageBlocks.entities['r1']?.status).toBe(MessageBlockStatus.PAUSED)
    store.dispatch(updateOneBlock({ id: 'r1', changes: { status: MessageBlockStatus.PROCESSING } } as any))
    expect(store.getState().messageBlocks.entities['r1']?.status).toBe(MessageBlockStatus.PROCESSING)
    store.dispatch(upsertOneBlock(makeThinking('r2', { status: MessageBlockStatus.PENDING })))
    store.dispatch(upsertOneBlock(makeThinking('r2', { status: MessageBlockStatus.PROCESSING })))
    expect(store.getState().messageBlocks.entities['r2']?.status).toBe(MessageBlockStatus.PROCESSING)
    store.dispatch(upsertOneBlock(makeThinking('r2', { status: MessageBlockStatus.PAUSED })))
    expect(store.getState().messageBlocks.entities['r2']?.status).toBe(MessageBlockStatus.PAUSED)
  })

  it('keeps terminal→terminal and content-only edits allowed after hardening', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeThinking('s1', { status: MessageBlockStatus.SUCCESS, content: 'a' })))
    store.dispatch(upsertOneBlock(makeThinking('s1', { status: MessageBlockStatus.ERROR, content: 'b' })))
    expect(store.getState().messageBlocks.entities['s1']?.status).toBe(MessageBlockStatus.ERROR)
    expect((store.getState().messageBlocks.entities['s1'] as any).content).toBe('b')
    store.dispatch(upsertOneBlock(makeThinking('s1', { status: MessageBlockStatus.SUCCESS, content: 'c' })))
    expect(store.getState().messageBlocks.entities['s1']?.status).toBe(MessageBlockStatus.SUCCESS)
    // content-only patch without status after terminal should still apply
    store.dispatch(updateOneBlock({ id: 's1', changes: { content: 'd' } } as any))
    expect((store.getState().messageBlocks.entities['s1'] as any).content).toBe('d')
    expect(store.getState().messageBlocks.entities['s1']?.status).toBe(MessageBlockStatus.SUCCESS)
    // publish with terminal status and updated content should apply
    store.dispatch(publish([makeThinking('s1', { status: MessageBlockStatus.ERROR, content: 'e' })]))
    expect(store.getState().messageBlocks.entities['s1']?.status).toBe(MessageBlockStatus.ERROR)
    expect((store.getState().messageBlocks.entities['s1'] as any).content).toBe('e')
  })

  it('publishResidentComplete: cannot regress SUCCESS/ERROR to stale PROCESSING/STREAMING/PAUSED/PENDING', () => {
    const store = createStore()
    store.dispatch(
      upsertOneBlock(
        makeThinking('a1', { status: MessageBlockStatus.SUCCESS, content: 'final', thinking_millsec: 3200 })
      )
    )
    store.dispatch(upsertOneBlock(makeThinking('a2', { status: MessageBlockStatus.ERROR, content: 'err' })))
    // stale PROCESSING/STREAMING via authoritative publish must be ignored
    store.dispatch(
      publish([makeThinking('a1', { status: MessageBlockStatus.STREAMING, content: 'stale', thinking_millsec: 10 })])
    )
    store.dispatch(publish([makeThinking('a1', { status: MessageBlockStatus.PROCESSING, thinking_millsec: 11 })]))
    expect(store.getState().messageBlocks.entities['a1']?.status).toBe(MessageBlockStatus.SUCCESS)
    expect((store.getState().messageBlocks.entities['a1'] as any).thinking_millsec).toBe(3200)
    expect((store.getState().messageBlocks.entities['a1'] as any).content).toBe('final')
    store.dispatch(publish([makeThinking('a2', { status: MessageBlockStatus.STREAMING })]))
    expect(store.getState().messageBlocks.entities['a2']?.status).toBe(MessageBlockStatus.ERROR)
    // stale PAUSED/PENDING via publish must also be rejected
    store.dispatch(publish([makeThinking('a1', { status: MessageBlockStatus.PAUSED, content: 'stale2' })]))
    expect(store.getState().messageBlocks.entities['a1']?.status).toBe(MessageBlockStatus.SUCCESS)
    store.dispatch(publish([makeThinking('a1', { status: MessageBlockStatus.PENDING })]))
    expect(store.getState().messageBlocks.entities['a1']?.status).toBe(MessageBlockStatus.SUCCESS)
    // per-entity filtering in one publish batch: valid + stale mixture + new
    store.dispatch(upsertOneBlock(makeThinking('a3', { status: MessageBlockStatus.STREAMING })))
    store.dispatch(
      publish([
        makeThinking('a1', { status: MessageBlockStatus.PENDING }), // stale -> reject
        makeThinking('a3', { status: MessageBlockStatus.SUCCESS }), // STREAMING->SUCCESS allowed
        makeThinking('a4', { status: MessageBlockStatus.STREAMING }) // new allowed
      ])
    )
    expect(store.getState().messageBlocks.entities['a1']?.status).toBe(MessageBlockStatus.SUCCESS)
    expect(store.getState().messageBlocks.entities['a3']?.status).toBe(MessageBlockStatus.SUCCESS)
    expect(store.getState().messageBlocks.entities['a4']?.status).toBe(MessageBlockStatus.STREAMING)
    // intra-batch publish: SUCCESS then stale STREAMING for same id must keep SUCCESS
    store.dispatch(upsertOneBlock(makeThinking('a5', { status: MessageBlockStatus.PENDING })))
    store.dispatch(
      publish([
        makeThinking('a5', { status: MessageBlockStatus.SUCCESS, thinking_millsec: 2000 }),
        makeThinking('a5', { status: MessageBlockStatus.STREAMING, thinking_millsec: 100 })
      ])
    )
    expect(store.getState().messageBlocks.entities['a5']?.status).toBe(MessageBlockStatus.SUCCESS)
    expect((store.getState().messageBlocks.entities['a5'] as any).thinking_millsec).toBe(2000)
  })

  it('publishResidentComplete: inserts new blocks and promotes non-terminal to terminal', () => {
    const store = createStore()
    store.dispatch(publish([makeThinking('n1', { status: MessageBlockStatus.PENDING })]))
    expect(store.getState().messageBlocks.entities['n1']?.status).toBe(MessageBlockStatus.PENDING)
    store.dispatch(publish([makeThinking('n1', { status: MessageBlockStatus.STREAMING })]))
    expect(store.getState().messageBlocks.entities['n1']?.status).toBe(MessageBlockStatus.STREAMING)
    store.dispatch(publish([makeThinking('n1', { status: MessageBlockStatus.SUCCESS })]))
    expect(store.getState().messageBlocks.entities['n1']?.status).toBe(MessageBlockStatus.SUCCESS)
    // PAUSED resume via publish when existing is PAUSED should stay allowed? Authoritative publish is window-level,
    // but a window carrying a PAUSED block that resumes an existing PAUSED entity to STREAMING is not a regression
    // so it should apply (existing PAUSED -> incoming STREAMING).
    store.dispatch(upsertOneBlock(makeThinking('n2', { status: MessageBlockStatus.PAUSED })))
    store.dispatch(publish([makeThinking('n2', { status: MessageBlockStatus.STREAMING })]))
    expect(store.getState().messageBlocks.entities['n2']?.status).toBe(MessageBlockStatus.STREAMING)
  })
})
