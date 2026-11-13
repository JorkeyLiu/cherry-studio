import { describe, expect, it } from 'vitest'

import messagesReducer, {
  newMessagesActions,
  selectHistoryReferenceForTopic,
  selectReferenceSourceNames
} from '../newMessage'
import { publishResidentComplete, retentionEvict } from '../residentRegistry'

const reference = {
  sourceTopicId: 'src-1',
  sourceBranchId: null,
  anchorMessageId: 'anchor-1',
  sourceName: 'Source',
  status: 'available' as const,
  boundaryMessageId: 'b-1'
}

const init = () => messagesReducer(undefined, { type: '@@INIT' })

const stateWith = (topicId: string) => {
  const next = messagesReducer(init(), newMessagesActions.historyReferenceSet({ topicId, reference }))
  return next
}

describe('newMessage historyReference metadata', () => {
  it('starts empty and sets topic-level reference metadata', () => {
    const initial = init()
    expect(initial.historyReferenceByTopic).toEqual({})
    const next = stateWith('dst-1')
    expect(next.historyReferenceByTopic['dst-1']).toEqual(reference)
  })

  it('clears metadata when a null/absent reference is committed', () => {
    const withRef = stateWith('dst-1')
    const cleared = messagesReducer(
      withRef,
      newMessagesActions.historyReferenceSet({ topicId: 'dst-1', reference: null })
    )
    expect(cleared.historyReferenceByTopic['dst-1']).toBeUndefined()
    // Only the target topic is affected.
    const other = messagesReducer(
      withRef,
      newMessagesActions.historyReferenceSet({ topicId: 'other', reference: null })
    )
    expect(other.historyReferenceByTopic['dst-1']).toEqual(reference)
  })

  it('clears metadata on a legacy full publish without a reference (ordinary topic)', () => {
    const withRef = stateWith('dst-1')
    const next = messagesReducer(
      withRef,
      newMessagesActions.messagesReceived({ topicId: 'dst-1', messages: [] as never[] })
    )
    expect(next.historyReferenceByTopic['dst-1']).toBeUndefined()
  })

  it('sets metadata from an authoritative full publish that carries a reference', () => {
    const next = messagesReducer(
      init(),
      newMessagesActions.messagesReceived({ topicId: 'dst-1', messages: [] as never[], reference })
    )
    expect(next.historyReferenceByTopic['dst-1']).toEqual(reference)
  })

  it('sets/clears metadata through the route rebase window read', () => {
    const set = messagesReducer(
      init(),
      newMessagesActions.rebaseRouteMessages({ topicId: 'dst-1', messages: [], reference })
    )
    expect(set.historyReferenceByTopic['dst-1']).toEqual(reference)
    const cleared = messagesReducer(
      set,
      newMessagesActions.rebaseRouteMessages({ topicId: 'dst-1', messages: [], reference: null })
    )
    expect(cleared.historyReferenceByTopic['dst-1']).toBeUndefined()
    // Non-authority rebase (no reference field) leaves metadata untouched.
    const untouched = messagesReducer(set, newMessagesActions.rebaseRouteMessages({ topicId: 'dst-1', messages: [] }))
    expect(untouched.historyReferenceByTopic['dst-1']).toEqual(reference)
  })

  it('sets/clears metadata through the resident window publication', () => {
    const windowResponse = { messages: [], blocks: [], mutableMessageIds: [], reference } as never
    const set = messagesReducer(
      init(),
      publishResidentComplete({ topicId: 'dst-1', generation: 1, windowResponse, segments: [] })
    )
    expect(set.historyReferenceByTopic['dst-1']).toEqual(reference)
    const cleared = messagesReducer(
      set,
      publishResidentComplete({
        topicId: 'dst-1',
        generation: 1,
        windowResponse: { messages: [], blocks: [], mutableMessageIds: [] } as never,
        segments: []
      })
    )
    expect(cleared.historyReferenceByTopic['dst-1']).toBeUndefined()
  })

  it('clears metadata on retention eviction', () => {
    const withRef = stateWith('dst-1')
    const next = messagesReducer(withRef, retentionEvict('dst-1'))
    expect(next.historyReferenceByTopic['dst-1']).toBeUndefined()
  })

  it('tolerates slice state without the historyReferenceByTopic map (preloaded/persisted)', () => {
    // A preloaded/persisted slice state may predate the field; reference
    // writes/clears must not throw and abort the reducer chain.
    const partial = { ...init() } as Record<string, unknown>
    delete partial.historyReferenceByTopic
    const set = messagesReducer(
      partial as never,
      newMessagesActions.historyReferenceSet({ topicId: 'dst-1', reference })
    )
    expect(set.historyReferenceByTopic['dst-1']).toEqual(reference)
    const cleared = messagesReducer(partial as never, retentionEvict('dst-1'))
    expect(cleared.historyReferenceByTopic?.['dst-1']).toBeUndefined()
  })

  it('retention eviction preserves canonical IDs still listed by another topic (shared foreign prefix)', () => {
    const shared = 'shared-msg-1'
    const msg = (id: string, topicId: string) => ({ id, topicId, role: 'user', blocks: [] }) as never
    let state = messagesReducer(
      init(),
      newMessagesActions.messagesReceived({ topicId: 'src', messages: [msg(shared, 'src')] })
    )
    state = messagesReducer(
      state,
      newMessagesActions.messagesReceived({ topicId: 'dst', messages: [msg(shared, 'src')] })
    )
    // Evict source: the shared canonical entity survives because the target
    // still lists it (read-only foreign prefix).
    const afterSourceEvict = messagesReducer(state, retentionEvict('src'))
    expect(afterSourceEvict.entities[shared]).toBeDefined()
    expect(afterSourceEvict.messageIdsByTopic['src']).toBeUndefined()
    expect(afterSourceEvict.messageIdsByTopic['dst']).toContain(shared)
    // Evicting the last lister removes the now-unreferenced entity.
    const afterBoth = messagesReducer(afterSourceEvict, retentionEvict('dst'))
    expect(afterBoth.entities[shared]).toBeUndefined()
  })

  it('selects metadata fail-closed for ordinary topics', () => {
    const withRef = stateWith('dst-1')
    const state = { messages: withRef } as never
    expect(selectHistoryReferenceForTopic(state, 'dst-1')).toEqual(reference)
    expect(selectHistoryReferenceForTopic(state, 'ordinary')).toBeUndefined()
  })

  it('carries the materialized chain layers through every authority write', () => {
    const layered = {
      ...reference,
      layers: [
        { ...reference, targetTopicId: 'dst-1' },
        {
          targetTopicId: 'src-0',
          sourceTopicId: 'src-0-root',
          sourceBranchId: null,
          anchorMessageId: 'anchor-0',
          sourceName: 'Root',
          status: 'available' as const,
          boundaryMessageId: 'b-0'
        }
      ]
    }
    const set = messagesReducer(
      init(),
      newMessagesActions.historyReferenceSet({ topicId: 'dst-1', reference: layered })
    )
    expect(set.historyReferenceByTopic['dst-1']).toEqual(layered)
    const rebased = messagesReducer(
      init(),
      newMessagesActions.rebaseRouteMessages({ topicId: 'dst-1', messages: [], reference: layered })
    )
    expect(rebased.historyReferenceByTopic['dst-1'].layers).toEqual(layered.layers)
    // Layers are derived metadata of the same relation: the nearest layer
    // still mirrors the relation itself.
    expect(rebased.historyReferenceByTopic['dst-1'].layers?.[0]).toEqual({
      ...reference,
      targetTopicId: 'dst-1'
    })
  })

  it('selects live source names for the immediate relation and every chain layer', () => {
    const layered = {
      ...reference,
      layers: [
        { ...reference, targetTopicId: 'dst-1' },
        {
          targetTopicId: 'src-1',
          sourceTopicId: 'src-0',
          sourceBranchId: null,
          anchorMessageId: 'anchor-0',
          sourceName: 'Stale ancestor name',
          status: 'available' as const,
          boundaryMessageId: 'b-0'
        }
      ]
    }
    const messages = messagesReducer(
      init(),
      newMessagesActions.historyReferenceSet({ topicId: 'dst-1', reference: layered })
    )
    const assistants = (topics: Array<{ id: string; name: string }>) => ({ assistants: [{ topics }] })
    const state = {
      messages,
      assistants: assistants([
        { id: 'src-1', name: 'Live Source' },
        { id: 'src-0', name: 'Live Root' }
      ])
    } as never
    expect(selectReferenceSourceNames(state, 'dst-1')).toEqual({
      'src-1': 'Live Source',
      'src-0': 'Live Root'
    })
    // Per-(assistant slice, metadata) memoization keeps the result stable.
    const again = selectReferenceSourceNames(state, 'dst-1')
    expect(again).toBe(selectReferenceSourceNames(state, 'dst-1'))
    // An ancestor rename (a new assistant slice) reflects immediately.
    const renamed = {
      messages,
      assistants: assistants([
        { id: 'src-1', name: 'Live Source' },
        { id: 'src-0', name: 'Renamed Root' }
      ])
    } as never
    expect(selectReferenceSourceNames(renamed, 'dst-1')['src-0']).toBe('Renamed Root')
  })

  it('selects an empty, referentially stable name map for ordinary topics', () => {
    const state = { messages: stateWith('dst-1') } as never
    const ordinary = selectReferenceSourceNames(state, 'ordinary')
    expect(ordinary).toEqual({})
    expect(selectReferenceSourceNames(state, 'ordinary')).toBe(ordinary)
  })

  it('omits sources that left the assistant catalog (metadata name stays the UI fallback)', () => {
    const layered = {
      ...reference,
      layers: [
        { ...reference, targetTopicId: 'dst-1' },
        {
          targetTopicId: 'src-1',
          sourceTopicId: 'gone-source',
          sourceBranchId: null,
          anchorMessageId: 'anchor-0',
          sourceName: 'Gone',
          status: 'available' as const,
          boundaryMessageId: 'b-0'
        }
      ]
    }
    const messages = messagesReducer(
      init(),
      newMessagesActions.historyReferenceSet({ topicId: 'dst-1', reference: layered })
    )
    const state = {
      messages,
      assistants: { assistants: [{ topics: [{ id: 'src-1', name: 'Live Source' }] }] }
    } as never
    expect(selectReferenceSourceNames(state, 'dst-1')).toEqual({ 'src-1': 'Live Source' })
  })
})
