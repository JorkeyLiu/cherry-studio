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
  createLatestMessageWindow,
  createOldestMessageWindow,
  createTargetMessageWindow,
  expandMessageWindowNewer,
  expandMessageWindowOlder,
  MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT
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
