import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import {
  createLatestMessageWindow,
  createOldestMessageWindow,
  createTargetMessageWindow,
  derivePaginationWindow,
  expandMessageWindowNewer,
  expandMessageWindowOlder,
  isHistoryHeadLoaded,
  MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT,
  reconcileMessageWindow
} from '../messageWindow'

const CALIBRATION_DEFAULT = MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT

const message = (id: string, role: Message['role'] = 'user', askId?: string): Message => ({
  id,
  role,
  askId,
  assistantId: 'assistant',
  topicId: 'topic',
  createdAt: '2026-07-19T00:00:00.000Z',
  status: role === 'user' ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS,
  blocks: []
})

const users = (count: number): Message[] => Array.from({ length: count }, (_, i) => message(`m${i}`))
const ids = (w: { displayMessages: Message[] }) => w.displayMessages.map(({ id }) => id)

describe('messageWindow bounded viewport B-06 calibration default', () => {
  it('exposes the B-06 calibration default as 200 groups (not a product threshold)', () => {
    expect(CALIBRATION_DEFAULT).toBe(200)
  })

  it('below calibration default: expand older/newer preserves existing semantics and hasMore', () => {
    const messages = users(10)
    const middle = createTargetMessageWindow(messages, 'm5', 1, 1)
    // 10 messages, middle 1+1+1=3 groups, below bound
    expect(middle.groupCount).toBe(3)
    expect(middle.boundedViewportObservability?.didTrim).toBe(false)
    expect(middle.boundedViewportObservability?.calibrationDefault).toBe(CALIBRATION_DEFAULT)

    const older = expandMessageWindowOlder(messages, middle, 2)
    // older range 2..6 count 5, below bound, no trim, hasMore truthful still derived
    expect(older.range).toEqual({ oldestGroupIndex: 2, newestGroupIndex: 6 })
    expect(older.groupCount).toBe(5)
    expect(older.boundedViewportObservability?.didTrim).toBe(false)
    expect(older.boundedViewportObservability?.trimmedEdge).toBeNull()
    expect(older.hasMoreOlder).toBe(true)
    expect(older.hasMoreNewer).toBe(true)

    const newer = expandMessageWindowNewer(messages, older, 3)
    expect(newer.range).toEqual({ oldestGroupIndex: 2, newestGroupIndex: 9 })
    expect(newer.groupCount).toBe(8)
    expect(newer.hasMoreNewer).toBe(false)
    expect(newer.boundedViewportObservability?.didTrim).toBe(false)
  })

  it('initial latest window never exceeds calibration default', () => {
    const messages = users(500)
    const win = createLatestMessageWindow(messages, 500)
    expect(win.groupCapacity).toBe(CALIBRATION_DEFAULT)
    expect(win.groupCount).toBe(CALIBRATION_DEFAULT)
    expect(win.range).toEqual({ oldestGroupIndex: 300, newestGroupIndex: 499 })
    expect(win.boundedViewportObservability?.calibrationDefault).toBe(CALIBRATION_DEFAULT)
    expect(win.boundedViewportObservability?.boundedCapacity).toBe(CALIBRATION_DEFAULT)
  })

  it('initial oldest window never exceeds calibration default', () => {
    const messages = users(500)
    const win = createOldestMessageWindow(messages, 500)
    expect(win.groupCapacity).toBe(CALIBRATION_DEFAULT)
    expect(win.groupCount).toBe(CALIBRATION_DEFAULT)
    expect(win.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 199 })
  })

  it('repeated older expansion trims newer edge deterministically and never exceeds bound', () => {
    const messages = users(400)
    // Start at latest window at bound
    const win = createLatestMessageWindow(messages, CALIBRATION_DEFAULT)
    expect(win.range).toEqual({ oldestGroupIndex: 200, newestGroupIndex: 399 })
    expect(win.groupCount).toBe(CALIBRATION_DEFAULT)

    // Expand older by 50 => desired oldest 150, provisional count 250 => trim newer by 50
    const older1 = expandMessageWindowOlder(messages, win, 50)
    expect(older1.groupCount).toBe(CALIBRATION_DEFAULT)
    expect(older1.groupCapacity).toBe(CALIBRATION_DEFAULT)
    expect(older1.range).toEqual({ oldestGroupIndex: 150, newestGroupIndex: 349 })
    expect(older1.boundedViewportObservability?.didTrim).toBe(true)
    expect(older1.boundedViewportObservability?.trimmedGroups).toBe(50)
    expect(older1.boundedViewportObservability?.trimmedEdge).toBe('newer')
    // older expansion trimmed newer edge only; oldest moved deterministically older by 50
    expect(older1.oldestMessageId).toBe('m150')
    expect(older1.newestMessageId).toBe('m349')
    expect(older1.hasMoreOlder).toBe(true)
    expect(older1.hasMoreNewer).toBe(true)

    // Repeated older expansion by 30 => oldest 120, newest 319 after trimming newer by 30
    const older2 = expandMessageWindowOlder(messages, older1, 30)
    expect(older2.groupCount).toBe(CALIBRATION_DEFAULT)
    expect(older2.range).toEqual({ oldestGroupIndex: 120, newestGroupIndex: 319 })
    expect(older2.boundedViewportObservability?.trimmedGroups).toBe(30)
    expect(older2.boundedViewportObservability?.trimmedEdge).toBe('newer')

    // Deterministic: same operation from same start produces same range
    const older1Again = expandMessageWindowOlder(messages, win, 50)
    expect(older1Again.range).toEqual(older1.range)
  })

  it('repeated newer expansion trims older edge deterministically and never exceeds bound', () => {
    const messages = users(400)
    const win = createOldestMessageWindow(messages, CALIBRATION_DEFAULT)
    expect(win.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 199 })

    const newer1 = expandMessageWindowNewer(messages, win, 50)
    expect(newer1.groupCount).toBe(CALIBRATION_DEFAULT)
    expect(newer1.range).toEqual({ oldestGroupIndex: 50, newestGroupIndex: 249 })
    expect(newer1.boundedViewportObservability?.didTrim).toBe(true)
    expect(newer1.boundedViewportObservability?.trimmedGroups).toBe(50)
    expect(newer1.boundedViewportObservability?.trimmedEdge).toBe('older')
    expect(newer1.hasMoreOlder).toBe(true)
    expect(newer1.hasMoreNewer).toBe(true)

    const newer2 = expandMessageWindowNewer(messages, newer1, 30)
    expect(newer2.range).toEqual({ oldestGroupIndex: 80, newestGroupIndex: 279 })
    expect(newer2.boundedViewportObservability?.trimmedGroups).toBe(30)

    const newer1Again = expandMessageWindowNewer(messages, win, 50)
    expect(newer1Again.range).toEqual(newer1.range)
  })

  it('boundary at capacity: exactly at bound does not trim, one beyond trims deterministically', () => {
    const messages = users(300)
    // Create window with 199 groups (just below bound)
    const win199 = createLatestMessageWindow(messages, 199)
    expect(win199.groupCount).toBe(199)
    const atBound = expandMessageWindowOlder(messages, win199, 1)
    expect(atBound.groupCount).toBe(200)
    expect(atBound.boundedViewportObservability?.didTrim).toBe(false)

    // One more older beyond bound => trim newer by 1
    const beyond = expandMessageWindowOlder(messages, atBound, 1)
    expect(beyond.groupCount).toBe(200)
    expect(beyond.boundedViewportObservability?.didTrim).toBe(true)
    expect(beyond.boundedViewportObservability?.trimmedGroups).toBe(1)
    expect(beyond.boundedViewportObservability?.trimmedEdge).toBe('newer')
    // Deterministic trim: oldest moves 1 older, newest also moves 1 older (trim)
    expect(beyond.range!.oldestGroupIndex).toBe(atBound.range!.oldestGroupIndex - 1)
    expect(beyond.range!.newestGroupIndex).toBe(atBound.range!.newestGroupIndex - 1)
  })

  it('hasMore flags remain truthful after bounded trimming (derived OR authoritative)', () => {
    const messages = users(400)
    const win = createLatestMessageWindow(messages, CALIBRATION_DEFAULT)
    // latest window at newest edge: hasMoreNewer false, hasMoreOlder true
    expect(win.hasMoreNewer).toBe(false)
    expect(win.hasMoreOlder).toBe(true)

    // After trimming newer edge via older expansion, hasMoreNewer must become true (local groups beyond window)
    const older = expandMessageWindowOlder(messages, win, 50)
    expect(older.hasMoreNewer).toBe(true)
    expect(older.hasMoreOlder).toBe(true)

    // With authoritative false but bounded trimming newer edge, only newer override surfaces; older explicit false is preserved
    const withAuthFalseTrimmedNewerEdge = expandMessageWindowOlder(messages, win, 50, {
      hasMoreBefore: false,
      hasMoreAfter: false
    })
    expect(withAuthFalseTrimmedNewerEdge.boundedViewportObservability?.didTrim).toBe(true)
    expect(withAuthFalseTrimmedNewerEdge.boundedViewportObservability?.trimmedEdge).toBe('newer')
    expect(withAuthFalseTrimmedNewerEdge.hasMoreOlder).toBe(false)
    expect(withAuthFalseTrimmedNewerEdge.hasMoreNewer).toBe(true)

    // With authoritative false but bounded trimming older edge, only older override surfaces; newer explicit false is preserved
    const oldestWin = createOldestMessageWindow(messages, CALIBRATION_DEFAULT)
    const withAuthFalseTrimmedOlderEdge = expandMessageWindowNewer(messages, oldestWin, 50, {
      hasMoreBefore: false,
      hasMoreAfter: false
    })
    expect(withAuthFalseTrimmedOlderEdge.boundedViewportObservability?.didTrim).toBe(true)
    expect(withAuthFalseTrimmedOlderEdge.boundedViewportObservability?.trimmedEdge).toBe('older')
    expect(withAuthFalseTrimmedOlderEdge.hasMoreOlder).toBe(true)
    expect(withAuthFalseTrimmedOlderEdge.hasMoreNewer).toBe(false)

    // With authoritative true, hasMore stays true even at edge
    const oldestWithAuthTrue = createOldestMessageWindow(messages, CALIBRATION_DEFAULT, {
      hasMoreBefore: true,
      hasMoreAfter: false
    })
    // even though oldestGroupIndex 0 => derived false, authoritative true => true
    expect(oldestWithAuthTrue.hasMoreOlder).toBe(true)
  })

  it('explicit authoritative false below capacity is preserved when no bounded trim occurred', () => {
    const messages = users(10)
    // Middle window 1+1+1 =3 groups, well below 200, no trim
    const middle = createTargetMessageWindow(messages, 'm5', 1, 1, { hasMoreBefore: false, hasMoreAfter: false })
    expect(middle.boundedViewportObservability?.didTrim).toBe(false)
    // derived would be true (oldest 4 >0, newest 6 <9), but authoritative false preserves false
    expect(middle.hasMoreOlder).toBe(false)
    expect(middle.hasMoreNewer).toBe(false)

    const older = expandMessageWindowOlder(messages, middle, 2, { hasMoreBefore: false, hasMoreAfter: false })
    expect(older.boundedViewportObservability?.didTrim).toBe(false)
    expect(older.range).toEqual({ oldestGroupIndex: 2, newestGroupIndex: 6 })
    // still below capacity, no trim, authoritative false remains false despite local derived true
    expect(older.hasMoreOlder).toBe(false)
    expect(older.hasMoreNewer).toBe(false)

    const newer = expandMessageWindowNewer(messages, older, 1, { hasMoreBefore: false, hasMoreAfter: false })
    expect(newer.boundedViewportObservability?.didTrim).toBe(false)
    expect(newer.hasMoreOlder).toBe(false)
    expect(newer.hasMoreNewer).toBe(false)

    // authoritative true still dominates even below capacity; explicit false preserved when no trim
    const withTrue = createTargetMessageWindow(messages, 'm0', 0, 2, { hasMoreBefore: true, hasMoreAfter: false })
    expect(withTrue.hasMoreOlder).toBe(true)
    // hasMoreAfter false preserved despite local derived true (newest 2 <9) because no bounded trim
    expect(withTrue.hasMoreNewer).toBe(false)
  })

  it('anchor/group continuity preserved after bounded trimming (deterministic IDs and ordering)', () => {
    const messages = users(400)
    const win = createLatestMessageWindow(messages, CALIBRATION_DEFAULT)
    const older = expandMessageWindowOlder(messages, win, 50)
    // Continuity: displayMessages ordering newest-to-oldest preserved
    const displayIds = ids(older)
    expect(displayIds[0]).toBe(older.newestMessageId)
    expect(displayIds[displayIds.length - 1]).toBe(older.oldestMessageId)
    // Stable group keys across trims: overlapping groups keep same keys
    const overlappingKeys = new Set(win.displayGroups.map((g) => g.key))
    const olderKeys = new Set(older.displayGroups.map((g) => g.key))
    // After older expansion with newer trim, the newest 150 groups of older should overlap with oldest 150 of win?
    // Actually win 200..399, older 150..349 => overlap 200..349 (150 groups)
    const overlapCount = [...overlappingKeys].filter((k) => olderKeys.has(k)).length
    expect(overlapCount).toBe(150)
    // Group continuity: displayGroups slice corresponds to range indices
    expect(older.displayGroups.length).toBe(older.groupCount)
    expect(older.displayGroups[0].messages[0].id).toBe('m150')
    expect(older.displayGroups[older.displayGroups.length - 1].messages.at(-1)!.id).toBe('m349')
  })

  it('viewport trimming is disposable: authoritative Redux entities not deleted (input messages unchanged)', () => {
    const messages = users(400)
    const originalLength = messages.length
    const originalIds = messages.map((m) => m.id)
    let win = createLatestMessageWindow(messages, CALIBRATION_DEFAULT)
    win = expandMessageWindowOlder(messages, win, 50)
    win = expandMessageWindowOlder(messages, win, 50)
    win = expandMessageWindowNewer(messages, win, 100)
    // Input messages array unchanged length and order
    expect(messages.length).toBe(originalLength)
    expect(messages.map((m) => m.id)).toEqual(originalIds)
    // Window groupCount still bounded
    expect(win.groupCount).toBeLessThanOrEqual(CALIBRATION_DEFAULT)
  })

  it('reconcile respects bounded capacity and does not exceed calibration default', () => {
    const previous = users(400)
    const win = createLatestMessageWindow(previous, CALIBRATION_DEFAULT)
    expect(win.groupCount).toBe(CALIBRATION_DEFAULT)
    const next = [...previous, message('m400'), message('m401')]
    const reconciled = reconcileMessageWindow(next, previous, win)
    // latest edge follows newest, still bounded
    expect(reconciled.groupCount).toBe(CALIBRATION_DEFAULT)
    expect(reconciled.groupCapacity).toBe(CALIBRATION_DEFAULT)
    expect(reconciled.boundedViewportObservability?.calibrationDefault).toBe(CALIBRATION_DEFAULT)
    // Fixed edge reconcile also bounded
    const fixedWin = createTargetMessageWindow(previous, 'm200', 10, 10)
    // Expand fixed to bound via older expansions
    const fixed = expandMessageWindowOlder(previous, fixedWin, 190)
    // After expansion to bound, reconcile with same messages should stay bounded
    const reconciledFixed = reconcileMessageWindow(previous, previous, fixed)
    expect(reconciledFixed.groupCount).toBeLessThanOrEqual(CALIBRATION_DEFAULT)
  })

  it('grouped assistant messages crossing the bound preserve group integrity and stable order', () => {
    // Build 400 groups where each assistant pair shares askId (2 messages per assistant group)
    const groupedMessages: Message[] = []
    for (let i = 0; i < 200; i++) {
      const userId = `u${i}`
      groupedMessages.push(message(userId, 'user'))
      const ask = `ask${i}`
      groupedMessages.push(message(`a${i}_0`, 'assistant', ask))
      groupedMessages.push(message(`a${i}_1`, 'assistant', ask))
    }
    // Each iteration yields 2 groups: user alone + assistant pair => 400 groups total
    const win = createLatestMessageWindow(groupedMessages, CALIBRATION_DEFAULT)
    expect(win.groupCount).toBe(CALIBRATION_DEFAULT)
    expect(win.groupCount).toBeLessThanOrEqual(200)
    // No assistant group is split
    for (const g of win.displayGroups) {
      if (g.semanticKey.startsWith('assistant:')) {
        expect(g.messages.length).toBe(2)
        expect(g.messages[0].askId).toBe(g.messages[1].askId)
      }
    }
    // Stable group order: displayGroups chronological matches range slice
    expect(win.displayGroups.length).toBe(win.groupCount)
    const flatIdsChronological = win.displayGroups.flatMap((g) => g.messages.map((m) => m.id))
    expect(flatIdsChronological).toEqual(win.displayGroups.flatMap((g) => g.messages).map((m) => m.id))
    // Newest-to-oldest displayMessages is reverse of chronological
    expect(win.displayMessages.map((m) => m.id)).toEqual([...flatIdsChronological].reverse())

    // Crossing the bound via opposite-edge trimming keeps groups intact
    const older = expandMessageWindowOlder(groupedMessages, win, 50)
    expect(older.groupCount).toBe(CALIBRATION_DEFAULT)
    expect(older.boundedViewportObservability?.didTrim).toBe(true)
    expect(older.boundedViewportObservability?.trimmedEdge).toBe('newer')
    for (const g of older.displayGroups) {
      if (g.semanticKey.startsWith('assistant:')) {
        expect(g.messages.length).toBe(2)
      }
    }
    // Overlap keys stable: overlapping 150 groups keep same keys
    const winKeys = new Set(win.displayGroups.map((g) => g.key))
    const olderKeys = new Set(older.displayGroups.map((g) => g.key))
    const overlap = [...winKeys].filter((k) => olderKeys.has(k)).length
    expect(overlap).toBe(150)
    // Oldest/newest message ids correspond to group boundaries
    expect(older.displayGroups[0].messages[0].id).toBe(older.oldestMessageId)
    expect(older.displayGroups[older.displayGroups.length - 1].messages.at(-1)!.id).toBe(older.newestMessageId)
  })

  it('over-capacity target navigation remains bounded with stable target, group count, and order', () => {
    const messages = users(500)
    const targetId = 'm250'
    // raw 150+1+150 =301 >200 => newer-first deterministic reduction to 200
    const win = createTargetMessageWindow(messages, targetId, 150, 150)
    expect(win.groupCount).toBeLessThanOrEqual(200)
    expect(win.groupCapacity).toBe(CALIBRATION_DEFAULT)
    expect(win.range).not.toBeNull()
    expect(win.groupCount).toBe(200)
    // Target remains visible and groups are intact
    expect(win.displayMessages.map((m) => m.id)).toContain(targetId)
    const targetGroup = win.displayGroups.find((g) => g.messages.some((m) => m.id === targetId))
    expect(targetGroup).toBeDefined()
    // Deterministic newer-first: effective newer trimmed first (150 ->49), older stays 150 => 150+1+49=200
    // Verify range size bounded and target within range
    const targetIndex = messages.findIndex((m) => m.id === targetId)
    // target group index in full model should be within window range
    expect(win.range!.oldestGroupIndex).toBeLessThanOrEqual(targetIndex)
    expect(win.range!.newestGroupIndex).toBeGreaterThanOrEqual(targetIndex)
    // Stable order: displayMessages newest-to-oldest equals reverse of chronological groups
    const chronological = win.displayGroups.flatMap((g) => g.messages)
    expect(win.displayMessages.map((m) => m.id)).toEqual(chronological.map((m) => m.id).toReversed())
    expect(win.displayGroups.length).toBe(win.groupCount)
    // Group order matches underlying message order
    const chronologicalIds = chronological.map((m) => m.id)
    const sortedByRange = messages.slice(win.range!.oldestGroupIndex, win.range!.newestGroupIndex + 1).map((m) => m.id)
    expect(chronologicalIds).toEqual(sortedByRange)

    // Another over-capacity variant: highly asymmetric quotas
    const win2 = createTargetMessageWindow(messages, targetId, 10, 250)
    expect(win2.groupCount).toBeLessThanOrEqual(200)
    expect(win2.displayMessages.map((m) => m.id)).toContain(targetId)
    expect(win2.range!.newestGroupIndex - win2.range!.oldestGroupIndex + 1).toBeLessThanOrEqual(200)
  })

  it('observability metadata is lightweight and testable without logging', () => {
    const messages = users(400)
    const win = createLatestMessageWindow(messages, 10)
    expect(win.boundedViewportObservability).toBeDefined()
    expect(win.boundedViewportObservability?.calibrationDefault).toBe(CALIBRATION_DEFAULT)
    expect(win.boundedViewportObservability?.boundedCapacity).toBe(10)
    // The newest-capacity slice omits the projection's older groups locally, so
    // the bound is reported honestly instead of reading as "nothing trimmed".
    expect(win.boundedViewportObservability?.didTrim).toBe(true)
    expect(win.boundedViewportObservability?.trimmedGroups).toBe(390)
    expect(win.boundedViewportObservability?.trimmedEdge).toBe('older')

    const bounded = expandMessageWindowOlder(messages, createLatestMessageWindow(messages, CALIBRATION_DEFAULT), 10)
    expect(bounded.boundedViewportObservability?.didTrim).toBe(true)
    expect(bounded.boundedViewportObservability?.trimmedEdge).toBe('newer')
    expect(typeof bounded.boundedViewportObservability?.trimmedGroups).toBe('number')
  })
})

describe('latest window local older omission vs Main authority', () => {
  // A 14-group loaded projection displayed at capacity 10: the display window
  // is the newest 10 groups (4..13) and 4 older groups stay resident but
  // outside it. Main may simultaneously report that it has no older page left
  // to read for this route — the two facts are independent.
  const projection = users(14)
  const capacity = 10
  const exhausted = { hasMoreBefore: false, hasMoreAfter: false }
  const chronologicalIds = projection.map(({ id }) => id)

  it('keeps the newest-capacity range and both authority flags while reporting the resident older page', () => {
    const win = createLatestMessageWindow(projection, capacity, exhausted)

    expect(win.range).toEqual({ oldestGroupIndex: 4, newestGroupIndex: 13 })
    expect(win.groupCount).toBe(capacity)
    expect(ids(win)).toEqual(chronologicalIds.slice(4).toReversed())
    // Main truth rides verbatim: nothing older to read.
    expect(win.authoritativeHasMoreBefore).toBe(false)
    expect(win.authoritativeHasMoreAfter).toBe(false)
    // The display can still show the 4 resident older groups.
    expect(win.hasMoreOlder).toBe(true)
    expect(win.hasMoreNewer).toBe(false)
    // The local trim is the reported mechanism, on the older edge only.
    expect(win.boundedViewportObservability?.didTrim).toBe(true)
    expect(win.boundedViewportObservability?.trimmedGroups).toBe(4)
    expect(win.boundedViewportObservability?.trimmedEdge).toBe('older')
  })

  it('never invents an older page when the whole projection fits at the bound', () => {
    const win = createLatestMessageWindow(users(capacity), capacity, exhausted)

    expect(win.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 9 })
    expect(win.hasMoreOlder).toBe(false)
    expect(win.hasMoreNewer).toBe(false)
    expect(win.authoritativeHasMoreBefore).toBe(false)
    expect(win.boundedViewportObservability?.didTrim).toBe(false)
    expect(win.boundedViewportObservability?.trimmedEdge).toBeNull()
  })

  it('still surfaces authoritative true at the head, independent of any local omission', () => {
    const win = createLatestMessageWindow(users(capacity), capacity, {
      hasMoreBefore: true,
      hasMoreAfter: false
    })

    expect(win.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 9 })
    expect(win.hasMoreOlder).toBe(true)
    expect(win.hasMoreNewer).toBe(false)
    expect(win.authoritativeHasMoreBefore).toBe(true)
    expect(win.boundedViewportObservability?.didTrim).toBe(false)
  })

  it('never opens the newer edge from a local older trim', () => {
    const win = createLatestMessageWindow(projection, capacity, exhausted)

    expect(win.range?.newestGroupIndex).toBe(projection.length - 1)
    expect(win.hasMoreNewer).toBe(false)
    expect(win.boundedViewportObservability?.trimmedEdge).not.toBe('newer')
  })

  it('pages from the tail window into the resident older groups and closes the flag at the local head', () => {
    const tail = createLatestMessageWindow(projection, capacity, exhausted)
    expect(tail.hasMoreOlder).toBe(true)

    const outcome = derivePaginationWindow({
      direction: 'older',
      messages: projection,
      currentWindow: tail,
      additionalGroupCount: capacity,
      responseWindow: exhausted
    })
    expect(outcome.status).toBe('accepted')
    if (outcome.status !== 'accepted') throw new Error('unreachable')
    const paged = outcome.window

    expect(paged.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 13 })
    expect(ids(paged)).toEqual(chronologicalIds.toReversed())
    // Nothing resident is left older than the displayed window now.
    expect(paged.hasMoreOlder).toBe(false)
    expect(paged.hasMoreNewer).toBe(false)
    expect(paged.authoritativeHasMoreBefore).toBe(false)
    expect(paged.paginationTarget).toBe(true)
  })

  it('retains the displayed old end across a latest-edge append (bounded growth, authority untouched)', () => {
    const tail = createLatestMessageWindow(projection, capacity, exhausted)
    const appended = [...projection, message('m14'), message('m15')]
    const reconciled = reconcileMessageWindow(appended, projection, tail)

    // The loaded old end stays mounted while the new tail enters: capacity
    // grows with the retained range instead of re-slicing newest-N.
    expect(reconciled.edge).toBe('latest')
    expect(reconciled.groupCount).toBe(capacity + 2)
    expect(reconciled.groupCapacity).toBe(capacity + 2)
    expect(reconciled.range).toEqual({ oldestGroupIndex: 4, newestGroupIndex: 15 })
    // Local older traversability and the verbatim Main authority are both
    // preserved — the authority is carried, never confused with the
    // latest-window completeness store (no write happens here).
    expect(reconciled.authoritativeHasMoreBefore).toBe(false)
    expect(reconciled.hasMoreOlder).toBe(true)
    expect(reconciled.hasMoreNewer).toBe(false)
  })

  it('claims the history head only when Main is exhausted AND the display reaches it', () => {
    // 14 resident groups shown as the newest 10: Main is exhausted, but 4
    // resident older groups are still browsable, so the head is not displayed.
    const tail = createLatestMessageWindow(projection, capacity, exhausted)
    expect(isHistoryHeadLoaded(tail)).toBe(false)

    // Same window after the resident older page is paged in: local head reached.
    const paged = derivePaginationWindow({
      direction: 'older',
      messages: projection,
      currentWindow: tail,
      additionalGroupCount: capacity,
      responseWindow: exhausted
    })
    expect(paged.status).toBe('accepted')
    if (paged.status !== 'accepted') throw new Error('unreachable')
    expect(isHistoryHeadLoaded(paged.window)).toBe(true)

    // Unknown authority is never a head, even at the display's own oldest row.
    expect(isHistoryHeadLoaded(createLatestMessageWindow(users(capacity), capacity))).toBe(false)
    // Main still has an older page: not the head either.
    expect(
      isHistoryHeadLoaded(
        createLatestMessageWindow(users(capacity), capacity, { hasMoreBefore: true, hasMoreAfter: false })
      )
    ).toBe(false)
    // No window at all: nothing is proven.
    expect(isHistoryHeadLoaded(null)).toBe(false)
    expect(isHistoryHeadLoaded(undefined)).toBe(false)
  })
})
