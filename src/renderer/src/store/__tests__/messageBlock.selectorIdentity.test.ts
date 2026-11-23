/**
 * Bounded identity contract for `selectMessageBlocksByIds`.
 *
 * The array reference returned by the selector means "same visible ordered
 * entities". These tests drive the real `messageBlocks` reducer and assert both
 * halves of that contract:
 *
 *  - reuse: an unrelated entity write (entities object replaced, unrelated
 *    block changed) or an unrelated slice write leaves the array reference
 *    previously returned for the same ID array untouched;
 *  - correctness: referenced updates, insert/delete, reorder, duplicate ids,
 *    missing→present, a new ID-array identity, empty/undefined ids and two
 *    distinct stores still produce the requested ordered entity set.
 *
 * Only the public selector is observed; no private cache shape is asserted.
 * Each test owns its store and ID arrays (no shared store object is held).
 */
import { configureStore, createSlice } from '@reduxjs/toolkit'
import type { MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import type { RootState } from '../index'
import messageBlocksReducer, {
  removeOneBlock,
  selectMessageBlocksByIds,
  updateOneBlock,
  upsertOneBlock
} from '../messageBlock'

const makeText = (id: string, content = `content-${id}`) =>
  ({
    id,
    messageId: `msg-${id}`,
    type: MessageBlockType.MAIN_TEXT,
    status: MessageBlockStatus.SUCCESS,
    createdAt: '2026-01-01T00:00:00.000Z',
    content
  }) as unknown as MessageBlock

function createStore() {
  const counter = createSlice({
    name: 'counter',
    initialState: { value: 0 },
    reducers: {
      increment: (state) => {
        state.value += 1
      }
    }
  })
  return configureStore({
    reducer: { messageBlocks: messageBlocksReducer, counter: counter.reducer },
    middleware: (g) => g({ serializableCheck: false })
  })
}

type TestStore = ReturnType<typeof createStore>

const selectBlocks = (store: TestStore, ids: readonly string[] | undefined) =>
  selectMessageBlocksByIds(store.getState() as unknown as RootState, ids)

const entityOf = (store: TestStore, id: string): MessageBlock => store.getState().messageBlocks.entities[id]

const idsOf = (blocks: MessageBlock[]) => blocks.map((block) => block.id)

const contentOf = (block: MessageBlock | undefined) => (block as { content?: string } | undefined)?.content

describe('selectMessageBlocksByIds bounded identity (reuse)', () => {
  it('keeps the array reference when an unrelated block is written', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeText('a1', 'a1 first')))
    store.dispatch(upsertOneBlock(makeText('a2', 'a2 first')))
    store.dispatch(upsertOneBlock(makeText('b1', 'b1 first')))
    const ids = ['a1', 'a2']
    const before = selectBlocks(store, ids)
    expect(idsOf(before)).toEqual(['a1', 'a2'])
    expect(before[0]).toBe(entityOf(store, 'a1'))
    expect(before[1]).toBe(entityOf(store, 'a2'))

    store.dispatch(updateOneBlock({ id: 'b1', changes: { content: 'b1 streamed' } }))
    const after = selectBlocks(store, ids)
    expect(after).toBe(before)
    expect(after[0]).toBe(entityOf(store, 'a1'))
    expect(after[1]).toBe(entityOf(store, 'a2'))
  })

  it('keeps the array reference when an unrelated slice writes', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeText('a1')))
    store.dispatch(upsertOneBlock(makeText('a2')))
    const ids = ['a1', 'a2']
    const before = selectBlocks(store, ids)
    store.dispatch({ type: 'counter/increment' })
    const after = selectBlocks(store, ids)
    expect(after).toBe(before)
  })

  it('does not evict one consumer when an alternating consumer is read', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeText('a1')))
    store.dispatch(upsertOneBlock(makeText('b1')))
    store.dispatch(upsertOneBlock(makeText('other')))
    const idsA = ['a1']
    const idsB = ['b1']

    const firstA = selectBlocks(store, idsA)
    const firstB = selectBlocks(store, idsB)

    store.dispatch(updateOneBlock({ id: 'other', changes: { content: 'unrelated write 1' } }))
    expect(selectBlocks(store, idsA)).toBe(firstA)
    expect(selectBlocks(store, idsB)).toBe(firstB)

    store.dispatch(updateOneBlock({ id: 'other', changes: { content: 'unrelated write 2' } }))
    expect(selectBlocks(store, idsB)).toBe(firstB)
    expect(selectBlocks(store, idsA)).toBe(firstA)
  })

  it('returns the same stable empty array for empty and absent ID sets', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeText('a1')))
    const emptyBefore = selectBlocks(store, [])
    const absentBefore = selectBlocks(store, undefined)
    expect(emptyBefore).toEqual([])
    expect(absentBefore).toEqual([])
    expect(emptyBefore).toBe(absentBefore)

    store.dispatch(updateOneBlock({ id: 'a1', changes: { content: 'streamed' } }))
    expect(selectBlocks(store, [])).toBe(emptyBefore)
    expect(selectBlocks(store, undefined)).toBe(absentBefore)
  })
})

describe('selectMessageBlocksByIds bounded identity (correctness)', () => {
  it('rebuilds when a referenced block updates and never hides changed content', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeText('a1', 'a1 first')))
    store.dispatch(upsertOneBlock(makeText('a2', 'a2 first')))
    const ids = ['a1', 'a2']
    const before = selectBlocks(store, ids)
    expect(contentOf(before[1])).toBe('a2 first')

    store.dispatch(updateOneBlock({ id: 'a2', changes: { content: 'a2 streamed' } }))
    const after = selectBlocks(store, ids)
    expect(after).not.toBe(before)
    expect(after[0]).toBe(entityOf(store, 'a1'))
    expect(after[1]).toBe(entityOf(store, 'a2'))
    expect(contentOf(after[1])).toBe('a2 streamed')
    // The previously returned array keeps its own snapshot of that moment.
    expect(contentOf(before[1])).toBe('a2 first')
  })

  it('responds to a missing block becoming present, in requested order', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeText('a1')))
    store.dispatch(upsertOneBlock(makeText('a3')))
    const ids = ['a1', 'a2', 'a3']
    const before = selectBlocks(store, ids)
    expect(idsOf(before)).toEqual(['a1', 'a3'])

    store.dispatch(upsertOneBlock(makeText('a2')))
    const after = selectBlocks(store, ids)
    expect(after).not.toBe(before)
    expect(idsOf(after)).toEqual(['a1', 'a2', 'a3'])
    expect(after[1]).toBe(entityOf(store, 'a2'))
  })

  it('responds to a referenced block removal', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeText('a1')))
    store.dispatch(upsertOneBlock(makeText('a2')))
    store.dispatch(upsertOneBlock(makeText('a3')))
    const ids = ['a1', 'a2', 'a3']
    const before = selectBlocks(store, ids)
    expect(idsOf(before)).toEqual(['a1', 'a2', 'a3'])

    store.dispatch(removeOneBlock('a2'))
    const after = selectBlocks(store, ids)
    expect(after).not.toBe(before)
    expect(idsOf(after)).toEqual(['a1', 'a3'])
    expect(after[0]).toBe(entityOf(store, 'a1'))
    expect(after[1]).toBe(entityOf(store, 'a3'))
    expect(idsOf(before)).toEqual(['a1', 'a2', 'a3'])
  })

  it('responds to an ID-array reorder while the old array keeps its order', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeText('a1')))
    store.dispatch(upsertOneBlock(makeText('a2')))
    const forwardIds = ['a1', 'a2']
    const reverseIds = ['a2', 'a1']
    const forward = selectBlocks(store, forwardIds)
    const reverse = selectBlocks(store, reverseIds)
    expect(idsOf(forward)).toEqual(['a1', 'a2'])
    expect(idsOf(reverse)).toEqual(['a2', 'a1'])
    expect(reverse[0]).toBe(entityOf(store, 'a2'))
    expect(reverse[1]).toBe(entityOf(store, 'a1'))
    expect(idsOf(forward)).toEqual(['a1', 'a2'])
  })

  it('keeps duplicate IDs in requested order', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeText('a1')))
    store.dispatch(upsertOneBlock(makeText('a2')))
    const ids = ['a2', 'a1', 'a2']
    const result = selectBlocks(store, ids)
    expect(idsOf(result)).toEqual(['a2', 'a1', 'a2'])
    expect(result[0]).toBe(entityOf(store, 'a2'))
    expect(result[2]).toBe(entityOf(store, 'a2'))
  })

  it('drops IDs that are not in the store and keeps the resolved order', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeText('a1')))
    store.dispatch(upsertOneBlock(makeText('a2')))
    const ids = ['missing-first', 'a1', 'missing-second', 'a2']
    const result = selectBlocks(store, ids)
    expect(idsOf(result)).toEqual(['a1', 'a2'])
  })

  it('answers a new ID-array identity with the same visible ordered entities', () => {
    const store = createStore()
    store.dispatch(upsertOneBlock(makeText('a1')))
    store.dispatch(upsertOneBlock(makeText('a2', 'a2 first')))
    const firstIds = ['a1', 'a2']
    const first = selectBlocks(store, firstIds)

    // Unrelated write forces the entities object to change, then an equal-content
    // but distinct array instance addresses the selector again.
    store.dispatch(updateOneBlock({ id: 'a2', changes: { content: 'a2 streamed' } }))
    const secondIds = ['a1', 'a2']
    const second = selectBlocks(store, secondIds)
    expect(idsOf(second)).toEqual(['a1', 'a2'])
    expect(second[0]).toBe(entityOf(store, 'a1'))
    expect(second[1]).toBe(entityOf(store, 'a2'))
    expect(contentOf(second[1])).toBe('a2 streamed')
    // Reuse is bounded by ID-array identity, so a new array is not required to
    // share the old array reference; only the visible entities must match.
    expect(contentOf(first[1])).toBe('a2 first')
  })

  it('resolves each store independently when the same ID array is reused', () => {
    const storeOne = createStore()
    storeOne.dispatch(upsertOneBlock(makeText('a1', 'from store one')))
    const storeTwo = createStore()
    storeTwo.dispatch(upsertOneBlock(makeText('a1', 'from store two')))
    const ids = ['a1']

    const fromOne = selectBlocks(storeOne, ids)
    const fromTwo = selectBlocks(storeTwo, ids)
    expect(fromOne[0]).toBe(entityOf(storeOne, 'a1'))
    expect(fromTwo[0]).toBe(entityOf(storeTwo, 'a1'))
    expect(contentOf(fromOne[0])).toBe('from store one')
    expect(contentOf(fromTwo[0])).toBe('from store two')

    // Reading store one again still resolves store one's own entity.
    const fromOneAgain = selectBlocks(storeOne, ids)
    expect(fromOneAgain[0]).toBe(entityOf(storeOne, 'a1'))
    expect(contentOf(fromOneAgain[0])).toBe('from store one')
  })
})
