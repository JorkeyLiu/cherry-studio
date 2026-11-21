/**
 * Tree clipboard delta → resident projection commit (in place).
 *
 * Promise guarded here: one committed tree command's route-scoped delta merges
 * into the projection the renderer already holds instead of re-imaging the
 * route. That means:
 * - every loaded older page keeps its resident slot and relative order (no
 *   rebase, no completeness reset, no viewport reset),
 * - placements follow Main's stable neighbours only (never a numeric index),
 * - removals apply to the loaded intersection (a row this window never held
 *   cannot leave it),
 * - capability is committed in the SAME action and only for rows the delta
 *   actually installed, and
 * - a delta produced for another route fails closed with zero change.
 */
import { configureStore } from '@reduxjs/toolkit'
import { rootReducer } from '@renderer/store'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import type { Message } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

const TOPIC = 'topic-1'

function msg(id: string, blocks: string[] = []): Message {
  return { id, role: 'user', topicId: TOPIC, blocks } as unknown as Message
}

/** Store whose resident window for TOPIC is exactly `ids` on `route`. */
function storeWithResident(ids: string[], route: string | null = null, mutableMessageIds: string[] = []) {
  const store = configureStore({ reducer: rootReducer })
  store.dispatch(
    newMessagesActions.messagesWindowMerged({
      topicId: TOPIC,
      messages: ids.map((id) => msg(id)),
      route,
      mutableMessageIds
    })
  )
  return store
}

function order(store: ReturnType<typeof storeWithResident>): string[] {
  return store.getState().messages.messageIdsByTopic[TOPIC] ?? []
}

function capability(store: ReturnType<typeof storeWithResident>): string[] {
  return [...(store.getState().messages.mutableMessageIdsByTopic[TOPIC] ?? [])].sort()
}

describe('applyClipboardTreeProjection (in-place resident commit)', () => {
  it('splices a pasted run at its Main tail neighbour and keeps every loaded older page', () => {
    // Multi-page resident window: the older pages are what the bug used to wipe.
    const store = storeWithResident(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], null, ['p5', 'p6'])

    store.dispatch(
      newMessagesActions.applyClipboardTreeProjection({
        topicId: TOPIC,
        route: null,
        messages: [msg('n1'), msg('n2')],
        removedMessageIds: [],
        runs: [
          {
            insertedMessageIds: ['n1', 'n2'],
            beforeMessageId: 'p6',
            nextMessageId: null,
            visibleMessageIds: ['n1', 'n2']
          }
        ],
        mutableMessageIds: ['n1', 'n2']
      })
    )

    expect(order(store)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'n1', 'n2'])
    // Capability is the same-route union: existing loaded rows keep theirs.
    expect(capability(store)).toEqual(['n1', 'n2', 'p5', 'p6'])
    expect(store.getState().messages.mutableRouteByTopic[TOPIC]).toBeNull()
    expect(store.getState().messages.entities.n1).toBeDefined()
  })

  it('applies removals to the loaded intersection only and drops their entities', () => {
    const store = storeWithResident(['p1', 'p2', 'p3', 'p4', 'p5'], null, ['p3', 'p4'])

    store.dispatch(
      newMessagesActions.applyClipboardTreeProjection({
        topicId: TOPIC,
        route: null,
        messages: [],
        // The last id is a row of this route that this window never loaded.
        removedMessageIds: ['p3', 'never-loaded'],
        runs: [],
        mutableMessageIds: []
      })
    )

    expect(order(store)).toEqual(['p1', 'p2', 'p4', 'p5'])
    expect(store.getState().messages.entities.p3).toBeUndefined()
    // Stale capability is pruned with its row; unrelated rows keep theirs.
    expect(capability(store)).toEqual(['p4'])
  })

  it('commits a cut+paste of the displayed route in ONE action (removal and placed run together)', () => {
    const store = storeWithResident(['p1', 'p2', 'p3', 'p4'], null, ['p1', 'p2', 'p3', 'p4'])

    store.dispatch(
      newMessagesActions.applyClipboardTreeProjection({
        topicId: TOPIC,
        route: null,
        messages: [msg('n1')],
        removedMessageIds: ['p3'],
        runs: [{ insertedMessageIds: ['n1'], beforeMessageId: 'p2', nextMessageId: 'p4', visibleMessageIds: ['n1'] }],
        mutableMessageIds: ['n1']
      })
    )

    expect(order(store)).toEqual(['p1', 'p2', 'n1', 'p4'])
    expect(capability(store)).toEqual(['n1', 'p1', 'p2', 'p4'])
  })

  it('never grants capability to a row this delta did not install', () => {
    const store = storeWithResident(['p1', 'p2'], null, [])

    store.dispatch(
      newMessagesActions.applyClipboardTreeProjection({
        topicId: TOPIC,
        route: null,
        messages: [msg('n1')],
        removedMessageIds: [],
        runs: [{ insertedMessageIds: ['n1'], beforeMessageId: 'p2', nextMessageId: null, visibleMessageIds: ['n1'] }],
        // p1 is resident but not part of this delta's placed run.
        mutableMessageIds: ['p1', 'n1']
      })
    )

    expect(capability(store)).toEqual(['n1'])
  })

  it('fails closed with zero change when the delta belongs to another route', () => {
    const store = storeWithResident(['p1', 'p2'], 'branch-other', ['p1'])
    const before = store.getState().messages

    store.dispatch(
      newMessagesActions.applyClipboardTreeProjection({
        topicId: TOPIC,
        route: null,
        messages: [msg('n1')],
        removedMessageIds: ['p1'],
        runs: [{ insertedMessageIds: ['n1'], beforeMessageId: 'p2', nextMessageId: null, visibleMessageIds: ['n1'] }],
        mutableMessageIds: ['n1']
      })
    )

    const after = store.getState().messages
    expect(after.messageIdsByTopic[TOPIC]).toEqual(['p1', 'p2'])
    expect(after.mutableRouteByTopic[TOPIC]).toBe('branch-other')
    expect(after.mutableMessageIdsByTopic[TOPIC]).toEqual(before.mutableMessageIdsByTopic[TOPIC])
    expect(after.entities.n1).toBeUndefined()
  })

  it('re-applying the same committed delta is idempotent (redo replay, in-flight re-publish)', () => {
    const store = storeWithResident(['p1', 'p2'], null, [])
    const payload = {
      topicId: TOPIC,
      route: null,
      messages: [msg('n1'), msg('n2')],
      removedMessageIds: [],
      runs: [
        {
          insertedMessageIds: ['n1', 'n2'],
          beforeMessageId: 'p2',
          nextMessageId: null,
          visibleMessageIds: ['n1', 'n2']
        }
      ],
      mutableMessageIds: ['n1', 'n2']
    }

    store.dispatch(newMessagesActions.applyClipboardTreeProjection(payload))
    store.dispatch(newMessagesActions.applyClipboardTreeProjection(payload))

    expect(order(store)).toEqual(['p1', 'p2', 'n1', 'n2'])
    expect(capability(store)).toEqual(['n1', 'n2'])
  })

  it('drops blocks exclusive to a removed row in the same dispatch', () => {
    const store = storeWithResident(['p1', 'p2'], null, [])
    store.dispatch(
      messageBlocksSlice.actions.upsertManyBlocks([
        { id: 'b-removed', messageId: 'p1', type: 'main_text', content: 'x' },
        { id: 'b-kept', messageId: 'p2', type: 'main_text', content: 'y' }
      ] as never)
    )

    store.dispatch(
      newMessagesActions.applyClipboardTreeProjection({
        topicId: TOPIC,
        route: null,
        messages: [],
        removedMessageIds: ['p1'],
        runs: [],
        mutableMessageIds: []
      })
    )

    expect(store.getState().messageBlocks.entities['b-removed']).toBeUndefined()
    expect(store.getState().messageBlocks.entities['b-kept']).toBeDefined()
  })
})
