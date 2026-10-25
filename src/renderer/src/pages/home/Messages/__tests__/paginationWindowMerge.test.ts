import * as fs from 'node:fs'

import { configureStore } from '@reduxjs/toolkit'
import { mergeWindowIntoTopic, unionWindowMessages } from '@renderer/pages/home/Messages/messageWindow'
import type { RootState } from '@renderer/store'
import reducer, { newMessagesActions, readLoadedProjectionMessages } from '@renderer/store/newMessage'
import residentRegistryReducer from '@renderer/store/residentRegistry'
import topicBranchReducer from '@renderer/store/topicBranch'
import type { Message } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

const TOPIC = 't1'

/** Message with an owner-local `sortOrder` that must never be re-applied globally. */
function msg(id: string, sortOrder?: number): Message {
  return { id, topicId: TOPIC, sortOrder } as unknown as Message
}

const ids = (messages: readonly Message[]): string[] => messages.map((m) => m.id)

const buildStore = () =>
  configureStore({
    reducer: {
      messages: reducer,
      residentRegistry: residentRegistryReducer,
      topicBranch: topicBranchReducer
    }
  })

type TestStore = ReturnType<typeof buildStore>

/** The store under test holds only the slices these helpers read. */
const rootState = (store: TestStore): RootState => store.getState() as unknown as RootState

const seedProjection = (store: TestStore, messages: Message[]) => {
  store.dispatch(newMessagesActions.messagesReceived({ topicId: TOPIC, messages }))
}

describe('mergeWindowIntoTopic (authoritative around-window merge)', () => {
  it('fails closed when the requested anchor is not resident (never concatenates a guess)', () => {
    // Resident tail only [M7]; the window is M1..M6 around M5. The pre-fix
    // behavior returned [M1..M4, M7, M6] — the anchor dropped and the route
    // order fabricated. The merge must publish nothing instead.
    const existing = [msg('M7')]
    const incoming = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'].map((id) => msg(id))
    expect(mergeWindowIntoTopic(existing, incoming, 'M5')).toEqual({ status: 'anchor-not-resident' })
  })

  it('fails closed when the response does not carry the requested anchor', () => {
    const existing = [msg('M5'), msg('M7')]
    const incoming = ['M1', 'M2', 'M3'].map((id) => msg(id))
    expect(mergeWindowIntoTopic(existing, incoming, 'M5')).toEqual({ status: 'anchor-not-in-window' })
    expect(mergeWindowIntoTopic(existing, incoming, '')).toEqual({ status: 'anchor-not-in-window' })
  })

  it('splices the window around the resident anchor in authoritative route order', () => {
    const existing = [msg('M5'), msg('M7')]
    const incoming = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'].map((id) => msg(id))
    const merged = mergeWindowIntoTopic(existing, incoming, 'M5')
    expect(merged.status).toBe('merged')
    if (merged.status !== 'merged') throw new Error('unreachable')
    expect(ids(merged.messages)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'])
    expect(merged.addedIds).toEqual(['M1', 'M2', 'M3', 'M4', 'M6'])
  })

  it('keeps current route order and never re-sorts by owner-local sortOrder', () => {
    // A branch route composes several owners' layers: these owner-local
    // sortOrders would reorder the merged list if they were applied globally.
    const existing = [msg('A', 900), msg('D', 50)]
    const incoming = [msg('B', 700), msg('A', 900), msg('C', 100)]
    const merged = mergeWindowIntoTopic(existing, incoming, 'A')
    expect(merged.status).toBe('merged')
    if (merged.status !== 'merged') throw new Error('unreachable')
    expect(ids(merged.messages)).toEqual(['B', 'A', 'C', 'D'])
  })

  it('deduplicates stable ids already resident (including repeats inside the window)', () => {
    const existing = [msg('M2'), msg('M5')]
    const incoming = [msg('M1'), msg('M2'), msg('M2'), msg('M5'), msg('M6')]
    const merged = mergeWindowIntoTopic(existing, incoming, 'M5')
    expect(merged.status).toBe('merged')
    if (merged.status !== 'merged') throw new Error('unreachable')
    expect(ids(merged.messages)).toEqual(['M1', 'M2', 'M5', 'M6'])
  })
})

describe('pagination merge against the CURRENT store projection', () => {
  it('reads the live projection (never a captured array) and commits it atomically', () => {
    const store = buildStore()
    seedProjection(store, [msg('M5'), msg('M7')])

    // A same-generation projection change lands while the page is in flight:
    // an appended stream/ack row at the tail. A captured component array would
    // still be [M5, M7] and the wholesale id-list commit would drop M8.
    store.dispatch(newMessagesActions.addMessage({ topicId: TOPIC, message: msg('M8') }))

    const currentProjection = readLoadedProjectionMessages(rootState(store), TOPIC)
    expect(ids(currentProjection)).toEqual(['M5', 'M7', 'M8'])

    const merged = mergeWindowIntoTopic(
      currentProjection,
      ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'].map((id) => msg(id)),
      'M5'
    )
    expect(merged.status).toBe('merged')
    if (merged.status !== 'merged') throw new Error('unreachable')

    store.dispatch(
      newMessagesActions.messagesWindowMerged({
        topicId: TOPIC,
        messages: merged.messages,
        route: null,
        mutableMessageIds: ['M1']
      })
    )
    expect(store.getState().messages.messageIdsByTopic[TOPIC]).toEqual(['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'])
    // Same-generation tail row survived; capability unioned in the same commit.
    expect(new Set(store.getState().messages.mutableMessageIdsByTopic[TOPIC])).toEqual(new Set(['M1']))
  })

  it('reads the CURRENT projection after a same-generation replacement (no stale resident loss)', () => {
    const store = buildStore()
    seedProjection(store, [msg('M5'), msg('M7')])
    // Same-generation projection replacement (e.g. a same-route window commit):
    // M7 left the resident projection.
    store.dispatch(
      newMessagesActions.messagesWindowMerged({
        topicId: TOPIC,
        messages: [msg('M5')],
        route: null,
        mutableMessageIds: []
      })
    )
    const currentProjection = readLoadedProjectionMessages(rootState(store), TOPIC)
    expect(ids(currentProjection)).toEqual(['M5'])

    // The window's own anchor is still resident: the page merges normally and
    // adopts the CURRENT projection (M7 does not come back from the stale array).
    const merged = mergeWindowIntoTopic(
      currentProjection,
      ['M1', 'M2', 'M3', 'M4', 'M5'].map((id) => msg(id)),
      'M5'
    )
    expect(merged.status).toBe('merged')
    if (merged.status !== 'merged') throw new Error('unreachable')
    expect(ids(merged.messages)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5'])
  })

  it('drops the page when the anchor left the projection, leaving the store untouched', () => {
    const store = buildStore()
    seedProjection(store, [msg('M5'), msg('M7')])
    // Anchor deleted / projection replaced while the read was in flight.
    store.dispatch(
      newMessagesActions.messagesWindowMerged({
        topicId: TOPIC,
        messages: [msg('M7')],
        route: null,
        mutableMessageIds: []
      })
    )
    const beforeIds = [...store.getState().messages.messageIdsByTopic[TOPIC]]

    const merge = mergeWindowIntoTopic(
      readLoadedProjectionMessages(rootState(store), TOPIC),
      ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'].map((id) => msg(id)),
      'M5'
    )
    // The production caller publishes only for `merged`; any other status means
    // no dispatch at all (existing reload/rebase path owns recovery).
    expect(merge.status).toBe('anchor-not-resident')
    expect(store.getState().messages.messageIdsByTopic[TOPIC]).toEqual(beforeIds)
  })
})

/**
 * Wiring guard for the pagination orchestration itself. The component is not
 * mounted here, so the structural contract is asserted on the production source:
 * the merge input is the CURRENT store projection (never the effect-mirrored
 * `messagesRef`), and the accepted-result/window derivation happens before the
 * single atomic publication.
 */
describe('Messages pagination orchestration wiring', () => {
  const source = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')

  const sliceOf = (startMarker: string, endMarker: string) => {
    const start = source.indexOf(startMarker)
    expect(start).toBeGreaterThanOrEqual(0)
    const end = source.indexOf(endMarker, start)
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  const loaderSlice = (): string =>
    sliceOf('const startWindowPageLoad', '// One app-owned browse-edge gate for BOTH directions')

  it('the ordinary page read is ONE direction-parameterized path that reads the current store projection and fails closed before publishing', () => {
    const slice = loaderSlice()
    expect(slice).toMatch(
      /mergeWindowIntoTopic\(\s*readLoadedProjectionMessages\(store\.getState\(\), topicIdAtStart\)/
    )
    expect(slice).not.toMatch(/mergeWindowIntoTopic\(\s*(messagesRef\.current|existing)/)
    expect(slice).toMatch(/merge\.status !== 'merged' \|\| !windowAtCommit/)
    // The applicability guard precedes the accepted-result commit.
    const guardIdx = slice.indexOf('isPaginationAttemptApplicable')
    const commitIdx = slice.indexOf('messagesWindowMerged')
    expect(guardIdx).toBeGreaterThanOrEqual(0)
    expect(commitIdx).toBeGreaterThan(guardIdx)
    // Both directions are the SAME path: edge anchor + derived window edge are
    // selected by the shared direction parameter, never by a second loader.
    expect(slice).toMatch(
      /direction === 'older' \? currentWindow\?\.oldestMessageId : currentWindow\?\.newestMessageId/
    )
    expect(slice).toMatch(/derivePaginationWindow\(\{/)
    expect((source.match(/const startWindowPageLoad/g) ?? []).length).toBe(1)
  })

  it('the ordinary page read owns one token-scoped fetch lease instead of a bare boolean', () => {
    const slice = loaderSlice()
    expect(slice).toMatch(/claimPaginationFetchLease\(paginationFetchLeaseRef\.current, loadToken\)/)
    expect(slice).toMatch(/releasePaginationFetchLease\(lease, loadToken\)/)
    expect(source).not.toMatch(/olderFetchInflightRef/)
    expect(source).toMatch(/isPaginationAttemptApplicable\(\{/)
  })
})

describe('unionWindowMessages (in-bound navigation assembly order)', () => {
  it('preserves the resident route order when the window shares a neighbour', () => {
    // On a branch route `sortOrder` is owner-local and the resident order is the
    // only authoritative route order: the window's new run is spliced at its
    // shared neighbour, never re-sorted globally.
    const existing = [msg('a', 5), msg('b', 1), msg('c', 9)]
    const incoming = [msg('x', 2), msg('b', 1), msg('y', 3)]
    const outcome = unionWindowMessages(existing, incoming)
    expect(outcome.status).toBe('merged')
    if (outcome.status !== 'merged') return
    expect(outcome.messages.map((m) => m.id)).toEqual(['a', 'x', 'b', 'y', 'c'])
  })

  it('never fabricates a route order for a disjoint window (owner-local sortOrder is not global)', () => {
    // No shared resident id ⇒ no provable route position. A global `sortOrder`
    // sort (which is what the historical fallback did) would publish an order
    // the authority never produced, so the union fails closed instead and the
    // caller takes the authoritative route-window rebase.
    const existing = [msg('a', 5), msg('b', 1), msg('c', 9)]
    const incoming = [msg('z', 2)]
    expect(unionWindowMessages(existing, incoming)).toEqual({ status: 'disjoint' })
    // Even with sortOrder values that would sort "cleanly", nothing is returned.
    expect(unionWindowMessages([msg('a', 1)], [msg('z', 2)])).toEqual({ status: 'disjoint' })
  })

  it('returns the resident projection unchanged when the window adds nothing new', () => {
    const existing = [msg('a'), msg('b')]
    const outcome = unionWindowMessages(existing, [msg('b'), msg('a')])
    expect(outcome).toEqual({ status: 'merged', messages: existing })
  })
})
