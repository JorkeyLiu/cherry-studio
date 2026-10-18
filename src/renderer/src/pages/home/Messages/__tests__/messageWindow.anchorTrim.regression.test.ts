/**
 * Regression coverage batch for already implemented Phase 4 B-06 viewport
 * anchor-preserving trim.
 *
 * Hardens thin proof around opposite-edge trim anchor preservation and
 * correct hasMore flags at the 200-group cap. Renderer-local only, no
 * B-01..B-05 retention/eviction/TTL/LRU, no IPC/shared/StoreSync/SQLite.
 *
 * Preserves Main SQLite authority, renderer disposable projections,
 * applicability-only generation tokens, typed completeness semantics,
 * B-06 target max 200 groups with opposite-edge trim and anchor preservation,
 * and existing B-07/B-08/B-09 bounds.
 */

import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import {
  canAdvancePaginationWindow,
  createLatestMessageWindow,
  createOldestMessageWindow,
  createTargetMessageWindow,
  derivePaginationWindow,
  expandMessageWindowNewer,
  expandMessageWindowOlder,
  MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT,
  type MessageWindow
} from '../messageWindow'

const CAL = MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT

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

describe('B-06 anchor-preserving trim regression — 200-group cap with opposite-edge trim', () => {
  it('exposes calibration default 200 and opposite-edge trim semantics', () => {
    expect(CAL).toBe(200)
  })

  it('expanding older at the 200-group cap trims newer edge while preserving stable oldest anchor and hasMore flags', () => {
    const messages = users(400) // 400 groups
    // Latest window at bound: 200..399 (200 groups)
    const win = createLatestMessageWindow(messages, CAL)
    expect(win.groupCount).toBe(CAL)
    expect(win.range).toEqual({ oldestGroupIndex: 200, newestGroupIndex: 399 })
    expect(win.oldestMessageId).toBe('m200')
    expect(win.newestMessageId).toBe('m399')
    // At newest edge, derived hasMoreNewer false, hasMoreOlder true
    expect(win.hasMoreOlder).toBe(true)
    expect(win.hasMoreNewer).toBe(false)
    expect(win.boundedViewportObservability?.didTrim).toBe(false)

    // Expand older by 50 beyond bound: provisional 150..399 (250) => trim newer 50 => 150..349
    const beforeOldest = win.oldestMessageId! // stable anchor: oldest at start
    const beforeNewest = win.newestMessageId!
    const older = expandMessageWindowOlder(messages, win, 50)

    // Bounds
    expect(older.groupCount).toBe(CAL)
    expect(older.groupCapacity).toBe(CAL)
    expect(older.range).toEqual({ oldestGroupIndex: 150, newestGroupIndex: 349 })
    // Opposite-edge trim metadata
    expect(older.boundedViewportObservability?.didTrim).toBe(true)
    expect(older.boundedViewportObservability?.trimmedEdge).toBe('newer')
    expect(older.boundedViewportObservability?.trimmedGroups).toBe(50)
    expect(older.boundedViewportObservability?.calibrationDefault).toBe(CAL)
    expect(older.boundedViewportObservability?.boundedCapacity).toBe(CAL)

    // Anchor preservation: previous oldest anchor remains visible; newest before trimmed away
    expect(older.displayGroups.some((g) => g.messages.some((m) => m.id === beforeOldest))).toBe(true)
    expect(older.displayGroups.some((g) => g.messages.some((m) => m.id === beforeNewest))).toBe(false)
    expect(older.oldestMessageId).toBe('m150')
    expect(older.newestMessageId).toBe('m349')

    // hasMore flags: both true when trimmed window is in middle (derived true on both edges)
    expect(older.hasMoreOlder).toBe(true)
    expect(older.hasMoreNewer).toBe(true)

    // Group continuity and ordering: newest-to-oldest displayMessages is reverse of chronological groups
    const chronological = older.displayGroups.flatMap((g) => g.messages.map((m) => m.id))
    expect(older.displayMessages.map((m) => m.id)).toEqual([...chronological].reverse())
    expect(older.displayGroups.length).toBe(older.groupCount)

    // No entity eviction: input messages unchanged
    expect(messages.length).toBe(400)
  })

  it('expanding newer at the 200-group cap trims older edge while preserving stable newest anchor and hasMore flags', () => {
    const messages = users(400)
    // Oldest window at bound: 0..199
    const win = createOldestMessageWindow(messages, CAL)
    expect(win.groupCount).toBe(CAL)
    expect(win.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 199 })
    expect(win.oldestMessageId).toBe('m0')
    expect(win.newestMessageId).toBe('m199')
    expect(win.hasMoreOlder).toBe(false)
    expect(win.hasMoreNewer).toBe(true)

    const beforeOldest = win.oldestMessageId!
    const beforeNewest = win.newestMessageId! // stable newest anchor
    const newer = expandMessageWindowNewer(messages, win, 50)

    // Provisional 0..249 (250) => trim older 50 => 50..249
    expect(newer.groupCount).toBe(CAL)
    expect(newer.range).toEqual({ oldestGroupIndex: 50, newestGroupIndex: 249 })
    expect(newer.boundedViewportObservability?.didTrim).toBe(true)
    expect(newer.boundedViewportObservability?.trimmedEdge).toBe('older')
    expect(newer.boundedViewportObservability?.trimmedGroups).toBe(50)

    // Anchor preservation: previous newest anchor remains; oldest before trimmed
    expect(newer.displayGroups.some((g) => g.messages.some((m) => m.id === beforeNewest))).toBe(true)
    expect(newer.displayGroups.some((g) => g.messages.some((m) => m.id === beforeOldest))).toBe(false)
    expect(newer.oldestMessageId).toBe('m50')
    expect(newer.newestMessageId).toBe('m249')

    expect(newer.hasMoreOlder).toBe(true)
    expect(newer.hasMoreNewer).toBe(true)
  })

  it('exactly at capacity does not trim; one beyond capacity deterministically trims opposite edge with correct flags', () => {
    const messages = users(300)
    const win199 = createLatestMessageWindow(messages, 199)
    expect(win199.groupCount).toBe(199)
    expect(win199.range).toEqual({ oldestGroupIndex: 101, newestGroupIndex: 299 })

    // To exactly 200: no trim
    const atBound = expandMessageWindowOlder(messages, win199, 1)
    expect(atBound.groupCount).toBe(200)
    expect(atBound.range).toEqual({ oldestGroupIndex: 100, newestGroupIndex: 299 })
    expect(atBound.boundedViewportObservability?.didTrim).toBe(false)
    expect(atBound.boundedViewportObservability?.trimmedEdge).toBeNull()
    // At bound but not yet trimmed, hasMore flags derived
    expect(atBound.hasMoreOlder).toBe(true)
    expect(atBound.hasMoreNewer).toBe(false)

    // One beyond bound: deterministic opposite-edge trim (oldest moves 1 older, newest moves 1 older)
    const beyond = expandMessageWindowOlder(messages, atBound, 1)
    expect(beyond.groupCount).toBe(200)
    expect(beyond.boundedViewportObservability?.didTrim).toBe(true)
    expect(beyond.boundedViewportObservability?.trimmedGroups).toBe(1)
    expect(beyond.boundedViewportObservability?.trimmedEdge).toBe('newer')
    expect(beyond.range!.oldestGroupIndex).toBe(atBound.range!.oldestGroupIndex - 1)
    expect(beyond.range!.newestGroupIndex).toBe(atBound.range!.newestGroupIndex - 1)
    // After trimming newer edge in middle, both hasMore become true
    expect(beyond.hasMoreOlder).toBe(true)
    expect(beyond.hasMoreNewer).toBe(true)

    // Determinism: same operation from same start produces same range
    const atBoundAgain = expandMessageWindowOlder(messages, win199, 1)
    expect(atBoundAgain.range).toEqual(atBound.range)
    const beyondAgain = expandMessageWindowOlder(messages, atBound, 1)
    expect(beyondAgain.range).toEqual(beyond.range)
  })

  it('authoritative hasMore false is preserved on the non-trimmed edge but overridden on the trimmed edge at the cap', () => {
    const messages = users(400)
    const win = createLatestMessageWindow(messages, CAL)
    // Expand older with authoritative false — trimmed newer edge should surface hasMoreNewer true, older false preserved
    const olderWithAuthFalse = expandMessageWindowOlder(messages, win, 50, {
      hasMoreBefore: false,
      hasMoreAfter: false
    })
    expect(olderWithAuthFalse.boundedViewportObservability?.didTrim).toBe(true)
    expect(olderWithAuthFalse.boundedViewportObservability?.trimmedEdge).toBe('newer')
    // Derived would be true on both edges, but authoritative false suppresses non-trimmed edge
    expect(olderWithAuthFalse.hasMoreOlder).toBe(false)
    expect(olderWithAuthFalse.hasMoreNewer).toBe(true)

    // Expand newer with authoritative false — trimmed older edge should surface hasMoreOlder true, newer false preserved
    const oldestWin = createOldestMessageWindow(messages, CAL)
    const newerWithAuthFalse = expandMessageWindowNewer(messages, oldestWin, 50, {
      hasMoreBefore: false,
      hasMoreAfter: false
    })
    expect(newerWithAuthFalse.boundedViewportObservability?.didTrim).toBe(true)
    expect(newerWithAuthFalse.boundedViewportObservability?.trimmedEdge).toBe('older')
    expect(newerWithAuthFalse.hasMoreOlder).toBe(true)
    expect(newerWithAuthFalse.hasMoreNewer).toBe(false)

    // Authoritative true dominates regardless of edge
    const withTrue = createOldestMessageWindow(messages, CAL, { hasMoreBefore: true, hasMoreAfter: false })
    expect(withTrue.hasMoreOlder).toBe(true)
    // When no trim, authoritative false preserved even though derived true (middle window below cap)
    const smallMsgs = users(10)
    const middle = createTargetMessageWindow(smallMsgs, 'm5', 1, 1, { hasMoreBefore: false, hasMoreAfter: false })
    expect(middle.boundedViewportObservability?.didTrim).toBe(false)
    expect(middle.hasMoreOlder).toBe(false)
    expect(middle.hasMoreNewer).toBe(false)
  })

  it('repeated opposite-edge trimming remains bounded at 200, preserves overlapping anchors, and never evicts entities', () => {
    const messages = users(500)
    let win = createLatestMessageWindow(messages, CAL)
    expect(win.range).toEqual({ oldestGroupIndex: 300, newestGroupIndex: 499 })

    // 4× older expansions of 40 each — each at bound trims newer 40 after first
    const initialOldest = win.oldestMessageId!
    expect(initialOldest).toBe('m300')
    for (let i = 0; i < 4; i++) {
      const beforeOldest = win.oldestMessageId!
      const beforeNewest = win.newestMessageId!
      const beforeCount = win.groupCount
      win = expandMessageWindowOlder(messages, win, 40)
      expect(win.groupCount).toBeLessThanOrEqual(CAL)
      expect(win.groupCount).toBe(CAL)
      if (win.boundedViewportObservability?.didTrim) {
        expect(win.boundedViewportObservability.trimmedEdge).toBe('newer')
        expect(win.displayGroups.some((g) => g.messages.some((m) => m.id === beforeOldest))).toBe(true)
        expect(win.newestMessageId).not.toBe(beforeNewest)
      } else {
        expect(win.groupCount).toBeGreaterThan(beforeCount)
      }
    }
    // Initial anchor still present after all trims (exact ID)
    expect(win.displayGroups.some((g) => g.messages.some((m) => m.id === initialOldest))).toBe(true)
    // Group count never exceeds 200, input not mutated
    expect(win.groupCount).toBe(CAL)
    expect(messages.length).toBe(500)

    // Mirror: newer expansions from oldest
    let win2 = createOldestMessageWindow(messages, CAL)
    const initialNewest = win2.newestMessageId!
    expect(initialNewest).toBe('m199')
    for (let i = 0; i < 4; i++) {
      const beforeNewest = win2.newestMessageId!
      win2 = expandMessageWindowNewer(messages, win2, 40)
      expect(win2.groupCount).toBe(CAL)
      if (win2.boundedViewportObservability?.didTrim) {
        expect(win2.boundedViewportObservability.trimmedEdge).toBe('older')
        expect(win2.displayGroups.some((g) => g.messages.some((m) => m.id === beforeNewest))).toBe(true)
      }
    }
    expect(win2.displayGroups.some((g) => g.messages.some((m) => m.id === initialNewest))).toBe(true)
  })

  it('over-capacity target navigation stays bounded, preserves target anchor, and maintains group order', () => {
    const messages = users(500)
    const targetId = 'm250'
    // raw 150+1+150=301 >200 => newer-first deterministic reduction: excess 101 trimmed newer first
    // effectiveOlder 150, effectiveNewer 49 => range 100..299 (200 groups), anchor visible, boundedCapacity 200
    const win = createTargetMessageWindow(messages, targetId, 150, 150)
    expect(win.groupCount).toBe(200)
    expect(win.groupCapacity).toBe(CAL)
    expect(win.range).toEqual({ oldestGroupIndex: 100, newestGroupIndex: 299 })
    expect(win.range!.newestGroupIndex - win.range!.oldestGroupIndex + 1).toBe(200)
    expect(win.boundedViewportObservability?.boundedCapacity).toBe(CAL)
    expect(win.displayMessages.map((m) => m.id)).toContain(targetId)
    const targetGroup = win.displayGroups.find((g) => g.messages.some((m) => m.id === targetId))
    expect(targetGroup).toBeDefined()
    // Stable order: displayMessages newest-to-oldest equals reverse of chronological groups
    const chronological = win.displayGroups.flatMap((g) => g.messages)
    expect(win.displayMessages.map((m) => m.id)).toEqual(chronological.map((m) => m.id).toReversed())
    // Deterministic newer-first exact edges contain anchor
    const targetIdx = messages.findIndex((m) => m.id === targetId)
    expect(win.range!.oldestGroupIndex).toBe(100)
    expect(win.range!.newestGroupIndex).toBe(299)
    expect(win.range!.oldestGroupIndex).toBeLessThanOrEqual(targetIdx)
    expect(win.range!.newestGroupIndex).toBeGreaterThanOrEqual(targetIdx)

    // Asymmetric over-capacity still bounded and anchor preserved
    // raw 10+1+250=261 excess 61 trim newer first => effectiveNewer 189 => range 240..439 (200 groups)
    const win2 = createTargetMessageWindow(messages, targetId, 10, 250)
    expect(win2.groupCount).toBe(200)
    expect(win2.range).toEqual({ oldestGroupIndex: 240, newestGroupIndex: 439 })
    expect(win2.range!.newestGroupIndex - win2.range!.oldestGroupIndex + 1).toBe(200)
    expect(win2.boundedViewportObservability?.boundedCapacity).toBe(CAL)
    expect(win2.displayMessages.map((m) => m.id)).toContain(targetId)
  })

  it('group integrity and hasMore bounds are correct after crossing the bound with opposite-edge trim', () => {
    const messages = users(400)
    const win = createLatestMessageWindow(messages, CAL)
    const older = expandMessageWindowOlder(messages, win, 50)
    // GroupCount bounded
    expect(older.groupCount).toBe(CAL)
    // Overlap stable: 150 groups overlap between win (200..399) and older (150..349)
    const winKeys = new Set(win.displayGroups.map((g) => g.key))
    const olderKeys = new Set(older.displayGroups.map((g) => g.key))
    const overlap = [...winKeys].filter((k) => olderKeys.has(k)).length
    expect(overlap).toBe(150)
    // hasMore both true in middle after trim
    expect(older.hasMoreOlder).toBe(true)
    expect(older.hasMoreNewer).toBe(true)
    // At newest edge before trim, hasMoreNewer false; after trim older, hasMoreNewer becomes true
    expect(win.hasMoreNewer).toBe(false)
    expect(older.hasMoreNewer).toBe(true)
    // Observability lightweight
    expect(older.boundedViewportObservability?.calibrationDefault).toBe(CAL)
    expect(typeof older.boundedViewportObservability?.trimmedGroups).toBe('number')
  })
})

describe('direction-parameterized pagination window transition (one derivation, both directions)', () => {
  /** Assert an ACCEPTED transition and return its window. */
  const accept = (input: Parameters<typeof derivePaginationWindow>[0]): MessageWindow => {
    const outcome = derivePaginationWindow(input)
    expect(outcome.status, `transition must be accepted (got ${JSON.stringify(outcome)})`).toBe('accepted')
    if (outcome.status !== 'accepted') throw new Error('unreachable')
    return outcome.window
  }

  it('grows the loaded edge only, and takes the response completeness flag for that edge alone', () => {
    const messages = users(300)
    const latest = createLatestMessageWindow(messages, CAL) // 100..299
    const older = accept({
      direction: 'older',
      messages,
      currentWindow: latest,
      additionalGroupCount: 20,
      responseWindow: { hasMoreBefore: false, hasMoreAfter: false }
    })
    expect(older.range).toEqual({ oldestGroupIndex: 80, newestGroupIndex: 279 })
    expect(older.groupCount).toBe(CAL)
    // Loaded edge carries the validated response truth…
    expect(older.hasMoreOlder).toBe(false)
    expect(older.authoritativeHasMoreBefore).toBe(false)
    // …and the untouched edge keeps the current window's own traversability:
    // trimming the newer edge made rows newer than the window locally reachable.
    expect(older.hasMoreNewer).toBe(true)

    const oldest = createOldestMessageWindow(messages, CAL) // 0..199
    const newer = accept({
      direction: 'newer',
      messages,
      currentWindow: oldest,
      additionalGroupCount: 20,
      responseWindow: { hasMoreBefore: false, hasMoreAfter: false }
    })
    expect(newer.range).toEqual({ oldestGroupIndex: 20, newestGroupIndex: 219 })
    expect(newer.groupCount).toBe(CAL)
    expect(newer.hasMoreNewer).toBe(false)
    expect(newer.authoritativeHasMoreAfter).toBe(false)
    expect(newer.hasMoreOlder).toBe(true)
  })

  it('keeps the derived window in route order for both directions (never a global re-sort)', () => {
    const messages = users(300)
    for (const [direction, start] of [
      ['older', createLatestMessageWindow(messages, CAL)],
      ['newer', createOldestMessageWindow(messages, CAL)]
    ] as const) {
      const next = accept({
        direction,
        messages,
        currentWindow: start,
        additionalGroupCount: 20,
        responseWindow: {}
      })
      const chronological = next.displayGroups.flatMap((group) => group.messages.map((m) => m.id))
      expect(next.displayMessages.map((m) => m.id)).toEqual([...chronological].reverse())
      expect(next.groupCount).toBe(next.displayGroups.length)
    }
  })

  it('never trims the retained live reading row away (bounded by calibration + one page)', () => {
    const messages = users(400)
    // Older page with the reading row near the NEWER edge: the exact-capacity
    // trim would drop it, so the trim is reduced instead of unmounting the row
    // the stable-anchor keeper holds.
    const latest = createLatestMessageWindow(messages, CAL) // 200..399
    const retained = accept({
      direction: 'older',
      messages,
      currentWindow: latest,
      additionalGroupCount: 50,
      responseWindow: {},
      retainMessageId: 'm385'
    })
    expect(retained.range).toEqual({ oldestGroupIndex: 150, newestGroupIndex: 385 })
    expect(retained.groupCount).toBe(236)
    expect(retained.boundedViewportObservability?.retentionClamped).toBe(true)
    expect(retained.boundedViewportObservability?.didTrim).toBe(true)
    expect(retained.boundedViewportObservability?.trimmedGroups).toBe(14)
    expect(retained.displayMessages.map((m) => m.id)).toContain('m385')
    expect(retained.oldestMessageId).toBe('m150')
    // Never beyond the provisional range (current window + this page).
    expect(retained.groupCount).toBeLessThanOrEqual(CAL + 50)

    // Without a retained row the trim is exact and the row leaves the window —
    // the retention is the only reason the trim is clamped.
    const dropped = accept({
      direction: 'older',
      messages,
      currentWindow: latest,
      additionalGroupCount: 50,
      responseWindow: {}
    })
    expect(dropped.range).toEqual({ oldestGroupIndex: 150, newestGroupIndex: 349 })
    expect(dropped.boundedViewportObservability?.retentionClamped).toBe(false)
    expect(dropped.displayMessages.map((m) => m.id)).not.toContain('m385')

    // Mirror for the newer direction (opposite edge is the older one).
    const oldest = createOldestMessageWindow(messages, CAL) // 0..199
    const newerRetained = accept({
      direction: 'newer',
      messages,
      currentWindow: oldest,
      additionalGroupCount: 50,
      responseWindow: {},
      retainMessageId: 'm15'
    })
    expect(newerRetained.range).toEqual({ oldestGroupIndex: 15, newestGroupIndex: 249 })
    expect(newerRetained.groupCount).toBe(235)
    expect(newerRetained.boundedViewportObservability?.retentionClamped).toBe(true)
    expect(newerRetained.displayMessages.map((m) => m.id)).toContain('m15')

    const newerDropped = accept({
      direction: 'newer',
      messages,
      currentWindow: oldest,
      additionalGroupCount: 50,
      responseWindow: {}
    })
    expect(newerDropped.range).toEqual({ oldestGroupIndex: 50, newestGroupIndex: 249 })
    expect(newerDropped.boundedViewportObservability?.retentionClamped).toBe(false)
  })

  it('an unresolvable retained row degrades to the exact bounded trim (no fake anchor)', () => {
    const messages = users(400)
    const latest = createLatestMessageWindow(messages, CAL)
    const next = accept({
      direction: 'older',
      messages,
      currentWindow: latest,
      additionalGroupCount: 50,
      responseWindow: {},
      retainMessageId: 'not-resident'
    })
    expect(next.range).toEqual({ oldestGroupIndex: 150, newestGroupIndex: 349 })
    expect(next.boundedViewportObservability?.retentionClamped).toBe(false)
  })

  it('repeated same-direction paging at the bound with the reading row on the trimmed edge stays bounded and resident', () => {
    const messages = users(900)
    // Latest window 700..899 with the reading row parked at the NEWEST row:
    // every older page would trim exactly that row away, so retention clamps
    // each page's trim — the hard case for the cap.
    const latest = createLatestMessageWindow(messages, CAL) // 700..899
    const reading = 'm899'

    // Page 1: accepted — the row stays resident and the window grows to exactly
    // one page over the calibration default (never more).
    const first = accept({
      direction: 'older',
      messages,
      currentWindow: latest,
      additionalGroupCount: 50,
      responseWindow: {},
      retainMessageId: reading
    })
    expect(first.range).toEqual({ oldestGroupIndex: 650, newestGroupIndex: 899 })
    expect(first.groupCount).toBe(CAL + 50)
    expect(first.displayMessages.map((m) => m.id)).toContain(reading)
    expect(first.boundedViewportObservability?.retentionClamped).toBe(true)

    // Page 2 with the SAME reading row still on the trimmed edge: keeping the row
    // and staying bounded cannot both hold, so the transition is DECLINED — no
    // window is produced at all, so the caller can publish nothing. The reading
    // row is never unmounted and the bound is never exceeded.
    const second = derivePaginationWindow({
      direction: 'older',
      messages,
      currentWindow: first,
      additionalGroupCount: 50,
      responseWindow: {},
      retainMessageId: reading
    })
    expect(second).toEqual({ status: 'declined', reason: 'retention-exceeds-bound' })

    // Same verdict from the pre-fetch guard, which is why no read is issued for
    // a provably un-honorable page.
    expect(
      canAdvancePaginationWindow({
        direction: 'older',
        messages,
        currentWindow: first,
        additionalGroupCount: 50,
        retainMessageId: reading
      })
    ).toEqual({ allowed: false, reason: 'retention-exceeds-bound' })

    // The user then advances (the reading row moves toward the loaded edge, i.e.
    // away from the trimmed edge): the SAME bound is now satisfiable, so paging
    // resumes, the row stays resident, and the accumulated overshoot is reclaimed
    // back to the exact calibration default.
    const advancedReading = 'm700'
    const third = accept({
      direction: 'older',
      messages,
      currentWindow: first,
      additionalGroupCount: 50,
      responseWindow: {},
      retainMessageId: advancedReading
    })
    expect(third.groupCount).toBe(CAL)
    expect(third.range).toEqual({ oldestGroupIndex: 600, newestGroupIndex: 799 })
    expect(third.displayMessages.map((m) => m.id)).toContain(advancedReading)
    expect(third.boundedViewportObservability?.retentionClamped).toBe(false)
    // The declined step left the committed window's traversability intact: the
    // accepted step still reports the older edge from the response and keeps the
    // newer edge locally traversable (the trim made rows newer than the window
    // reachable again).
    expect(third.hasMoreNewer).toBe(true)
  })

  it('the newer direction mirrors the same decline/advance/resume contract', () => {
    const messages = users(900)
    const oldest = createOldestMessageWindow(messages, CAL) // 0..199
    const reading = 'm0'

    const first = accept({
      direction: 'newer',
      messages,
      currentWindow: oldest,
      additionalGroupCount: 50,
      responseWindow: {},
      retainMessageId: reading
    })
    expect(first.range).toEqual({ oldestGroupIndex: 0, newestGroupIndex: 249 })
    expect(first.groupCount).toBe(CAL + 50)
    expect(first.displayMessages.map((m) => m.id)).toContain(reading)

    const second = derivePaginationWindow({
      direction: 'newer',
      messages,
      currentWindow: first,
      additionalGroupCount: 50,
      responseWindow: {},
      retainMessageId: reading
    })
    expect(second).toEqual({ status: 'declined', reason: 'retention-exceeds-bound' })

    const advanced = accept({
      direction: 'newer',
      messages,
      currentWindow: first,
      additionalGroupCount: 50,
      responseWindow: {},
      retainMessageId: 'm199'
    })
    expect(advanced.groupCount).toBe(CAL)
    expect(advanced.displayMessages.map((m) => m.id)).toContain('m199')
    expect(advanced.hasMoreOlder).toBe(true)
  })

  it('an ordinary reading position keeps the trim exact AND keeps the row resident', () => {
    const messages = users(900)
    // Reading row near the LOADED edge of the window (the real older-paging
    // position): retention has nothing to clamp and the cap is met exactly.
    const latest = createLatestMessageWindow(messages, CAL) // 700..899
    const older = accept({
      direction: 'older',
      messages,
      currentWindow: latest,
      additionalGroupCount: 50,
      responseWindow: {},
      retainMessageId: 'm705'
    })
    expect(older.range).toEqual({ oldestGroupIndex: 650, newestGroupIndex: 849 })
    expect(older.groupCount).toBe(CAL)
    expect(older.displayMessages.map((m) => m.id)).toContain('m705')
    expect(older.boundedViewportObservability?.retentionClamped).toBe(false)

    // Newer direction mirror: exact cap, retained row resident.
    const oldest = createOldestMessageWindow(messages, CAL) // 0..199
    const newer = accept({
      direction: 'newer',
      messages,
      currentWindow: oldest,
      additionalGroupCount: 50,
      responseWindow: {},
      retainMessageId: 'm195'
    })
    expect(newer.range).toEqual({ oldestGroupIndex: 50, newestGroupIndex: 249 })
    expect(newer.groupCount).toBe(CAL)
    expect(newer.displayMessages.map((m) => m.id)).toContain('m195')
    expect(newer.boundedViewportObservability?.retentionClamped).toBe(false)

    // Same mirror on the trimmed edge: clamped once, still inside one page.
    const newerClamped = accept({
      direction: 'newer',
      messages,
      currentWindow: oldest,
      additionalGroupCount: 50,
      responseWindow: {},
      retainMessageId: 'm15'
    })
    expect(newerClamped.groupCount).toBe(CAL + 35)
    expect(newerClamped.groupCount).toBeLessThanOrEqual(CAL + 50)
    expect(newerClamped.boundedViewportObservability?.retentionClamped).toBe(true)
  })
})
