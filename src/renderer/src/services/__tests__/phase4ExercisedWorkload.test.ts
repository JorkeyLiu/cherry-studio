/**
 * Phase 4 exercised-workload validation increment — renderer-local persistent-like mixed workload
 * for B-06/B-07/B-08/B-09 bounds via public/local boundaries.
 *
 * Coherent, deterministic, renderer-local only. No B-01..B-05 policy, no IPC/shared/StoreSync/SQLite,
 * no persistence change beyond B-07 device-local Keyv mock. Scalar-only, privacy-safe snapshots.
 *
 * Proves:
 * - B-06 viewport max 200 groups, opposite-edge trim, anchor preservation (exact IDs) via public messageWindow, no entity eviction
 * - B-07 scroll snapshots max 256, 90-day TTL + LRU with deterministic tie-break, identities/newest/touch recency, rebuild/repair, hard-delete invalidation
 * - B-08 ContentSearch max 500 live Range per disposable session via actual component/DOM lifecycle (>500 matches/chunks, owner replacement/navigation, unmount cleanup)
 * - B-09 context-closure active-topic retention max 1 (identity), generation/fingerprint/deletion invalidation and stale rejection
 * - Resident lifecycle complete -> incomplete/generation advance -> stale rejection -> deletion/clear via scalars
 * - Resident read-path hit/miss reason, staged latency (success+failure), discarded validation-only
 * - Coherent Phase4 snapshot/bound scalars are scalar-only, bounded, privacy-safe (recursive shape/value validation, sentinel rejection)
 */

import { configureStore } from '@reduxjs/toolkit'
import { ContentSearch, type ContentSearchRef } from '@renderer/components/ContentSearch'
import {
  createContentSearchSessionOwnerId,
  getActiveContentSearchOwnerForTests,
  getContentSearchDiagnostics,
  recordContentSearchCommit,
  recordContentSearchInvalidation,
  recordContentSearchRescanIncrement,
  releaseContentSearchSessionIfOwned,
  resetContentSearchDiagnosticsForTests
} from '@renderer/components/contentSearchDiagnostics'
import {
  createLatestMessageWindow,
  createOldestMessageWindow,
  createTargetMessageWindow,
  expandMessageWindowNewer,
  expandMessageWindowOlder,
  MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT,
  reconcileMessageWindow
} from '@renderer/pages/home/Messages/messageWindow'
import {
  bumpAndInvalidate,
  bumpClosureGeneration,
  computeClosureFingerprint,
  enforceContextClosureRetention,
  getAllCachedTopicIds,
  getCachedClosureGeneration,
  getCachedContextClosure,
  getContextClosureDiagnostics,
  getCurrentClosureGeneration,
  getFreshValidatedClosure,
  resetAllClosureStateForTests,
  resetContextClosureDiagnosticsForTests,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import { getB06Diagnostics, getPhase4BoundScalars, getPhase4Snapshot } from '@renderer/services/phase4Observability'
import { getResidentDiagnostics } from '@renderer/services/residentDiagnostics'
import {
  getResidentReadDiagnostics,
  recordResidentReadDiscard,
  recordResidentReadHit,
  recordResidentReadMiss,
  recordStagedLatency,
  resetResidentReadDiagnosticsForTests
} from '@renderer/services/residentReadDiagnostics'
import {
  enforceScrollSnapshotBounds,
  getScrollSnapshotDiagnostics,
  handleScrollSnapshotRead,
  handleScrollSnapshotSaved,
  removeScrollSnapshotsForTopicIds,
  resetScrollSnapshotCacheForTests,
  resetScrollSnapshotDiagnosticsForTests,
  SCROLL_SNAPSHOT_MAX_COUNT,
  SCROLL_SNAPSHOT_TTL_MS
} from '@renderer/services/scrollSnapshotCache'
import residentRegistryReducer, {
  bumpGeneration,
  clearEntry as clearResidentEntry,
  invalidateForDeletion,
  publishResidentComplete,
  resetAllResidentRegistry,
  shouldDiscardJointPublish
} from '@renderer/store/residentRegistry'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import type { FetchContextClosureResponse, FetchMessagesWindowResponse } from '@shared/chatDb'
import { act, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Deterministic fixtures and privacy sentinels
// ---------------------------------------------------------------------------
const FIXED_NOW = 1_700_000_000_000

const SENTINEL_TOPIC = 'sentinel-topic-UNIQUE-9c284b7f-7f3a9b'
const SENTINEL_CONTENT = 'SENTINEL_CONTENT_SENTINEL_abc123xyz_UNIQUE'
const SENTINEL_PATH = '/tmp/sentinel_path_SENTINEL_cred_secret_456'
const SENTINEL_CREDENTIAL = 'sentinel_credential_SENTINEL_secret_789'
const SENTINEL_HISTORY = 'sentinel_history_SENTINEL_entry_999'
const SENTINEL_IDS = [SENTINEL_TOPIC, SENTINEL_CONTENT, SENTINEL_PATH, SENTINEL_CREDENTIAL, SENTINEL_HISTORY]

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

function makeClosureResp(
  topicId = 't1',
  anchor = 'u1',
  ids: string[] = ['u1', 'a1', 'u2']
): FetchContextClosureResponse {
  const messages = ids.map((id) => ({
    id,
    role: id.startsWith('u') ? 'user' : 'assistant',
    topicId,
    ...(id.startsWith('a') ? { askId: 'u1' } : {})
  }))
  return {
    messages: messages as any,
    blocks: [],
    closure: {
      completeness: 'context-closure' as const,
      topicId,
      anchorGroupKey: anchor,
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length
    }
  } as any
}

function makeWindowResponse(topicId: string, ids: string[]): FetchMessagesWindowResponse {
  const returnedCount = ids.length
  return {
    messages: ids.map((id) => ({ id, topicId })) as unknown as FetchMessagesWindowResponse['messages'],
    blocks: [] as unknown as FetchMessagesWindowResponse['blocks'],
    window: {
      kind: 'latest',
      completeness: 'window',
      topicId,
      anchorMessageId: null,
      requested: { limit: 10 },
      firstMessageId: returnedCount > 0 ? ids[0] : null,
      lastMessageId: returnedCount > 0 ? ids[returnedCount - 1] : null,
      returnedCount,
      hasMoreBefore: false,
      hasMoreAfter: false
    }
  } as unknown as FetchMessagesWindowResponse
}

// Keyv mock for B-07 — deterministic, no timers
let store: Map<string, unknown>
function createKeyvMock() {
  return {
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown) => store.set(k, v),
    remove: (k: string) => {
      const had = store.has(k)
      store.delete(k)
      return had
    },
    keys: () => Array.from(store.keys())
  }
}

// ContentSearch jsdom stubs (actual component lifecycle)
const highlightsMock = { clear: vi.fn(), set: vi.fn(), delete: vi.fn() }
// @ts-ignore
global.CSS = (global as any).CSS || {}
// @ts-ignore
global.CSS.highlights = highlightsMock
let highlightArgs: any[][] = []
// @ts-ignore
global.Highlight = class Highlight {
  args: any[]
  constructor(...args: any[]) {
    this.args = args
    highlightArgs.push(args)
  }
}

vi.mock('@renderer/utils', async () => {
  const actual = await vi.importActual('@renderer/utils')
  return { ...(actual as any), scrollElementIntoView: vi.fn() }
})

const makeFilter = (): NodeFilter => ({ acceptNode: () => NodeFilter.FILTER_ACCEPT }) as any

// Recursive privacy-safe snapshot validator (audit B-privacy)
function assertSnapshotPrivacySafe(snap: ReturnType<typeof getPhase4Snapshot>, sentinels: string[]) {
  const serialized = JSON.stringify(snap)
  for (const s of sentinels) {
    expect(serialized).not.toContain(s)
  }
  // Top-level shape allowlist
  const allowedTop = ['b06', 'b07', 'b08', 'b09', 'resident', 'residentRead'].sort()
  expect(Object.keys(snap).sort()).toEqual(allowedTop)

  // B-06
  if (snap.b06 !== null) {
    const allowedB06 = [
      'boundedCapacity',
      'calibrationDefault',
      'didTrim',
      'groupCapacity',
      'groupCount',
      'hasMoreNewer',
      'hasMoreOlder',
      'trimmedEdge',
      'trimmedGroups'
    ].sort()
    expect(Object.keys(snap.b06).sort()).toEqual(allowedB06)
    for (const [k, v] of Object.entries(snap.b06)) {
      if (k === 'trimmedEdge') {
        expect(v === null || v === 'older' || v === 'newer').toBe(true)
      } else if (k === 'didTrim' || k === 'hasMoreOlder' || k === 'hasMoreNewer') {
        expect(typeof v).toBe('boolean')
      } else {
        expect(typeof v).toBe('number')
        expect(Number.isFinite(v as number)).toBe(true)
      }
    }
  } else {
    expect(snap.b06).toBeNull()
  }

  // B-07 including lastEnforcement allowlist
  const allowedB07 = ['indexCount', 'lastEnforcement', 'maxCount', 'ttlMs'].sort()
  expect(Object.keys(snap.b07).sort()).toEqual(allowedB07)
  expect(typeof snap.b07.indexCount).toBe('number')
  expect(typeof snap.b07.maxCount).toBe('number')
  expect(typeof snap.b07.ttlMs).toBe('number')
  if (snap.b07.lastEnforcement !== null) {
    const allowedLE = ['didRebuild', 'expiredRemoved', 'indexCountAfter', 'indexCountBefore', 'lruEvicted'].sort()
    expect(Object.keys(snap.b07.lastEnforcement).sort()).toEqual(allowedLE)
    for (const [k, v] of Object.entries(snap.b07.lastEnforcement)) {
      if (k === 'didRebuild') expect(typeof v).toBe('boolean')
      else {
        expect(typeof v).toBe('number')
        expect(Number.isFinite(v as number)).toBe(true)
      }
    }
  } else {
    expect(snap.b07.lastEnforcement).toBeNull()
  }

  // B-08
  const allowedB08 = [
    'chunkIndex',
    'chunkSize',
    'domGeneration',
    'invalidationCount',
    'liveRangeCount',
    'maxLiveRanges',
    'rescanCount',
    'totalCount'
  ].sort()
  expect(Object.keys(snap.b08).sort()).toEqual(allowedB08)
  for (const v of Object.values(snap.b08)) {
    expect(typeof v).toBe('number')
    expect(Number.isFinite(v as number)).toBe(true)
  }

  // B-09
  const allowedB09 = ['hitCount', 'maxRetainedTopics', 'missCount', 'retainedTopicCount', 'totalAccessCount'].sort()
  expect(Object.keys(snap.b09).sort()).toEqual(allowedB09)
  for (const v of Object.values(snap.b09)) {
    expect(typeof v).toBe('number')
    expect(Number.isFinite(v as number)).toBe(true)
  }

  // resident
  const allowedResident = [
    'chatDataCount',
    'entryCount',
    'incompleteCount',
    'maxGeneration',
    'residentCount',
    'segmentsCount'
  ].sort()
  expect(Object.keys(snap.resident).sort()).toEqual(allowedResident)
  for (const v of Object.values(snap.resident)) {
    expect(typeof v).toBe('number')
    expect(Number.isFinite(v as number)).toBe(true)
  }

  // residentRead
  const allowedRead = [
    'discardedCount',
    'discardedCurrentMoved',
    'discardedDeletedDuringFetch',
    'discardedGenerationMismatch',
    'discardedMalformed',
    'discardedSuperseded',
    'hitCount',
    'missCount',
    'missDeletion',
    'missForced',
    'missIncomplete',
    'missLegacyEmpty',
    'missNoEntry',
    'missNoIndex',
    'stagedAvgMs',
    'stagedCount',
    'stagedFailedCount',
    'stagedLastMs',
    'stagedMaxMs',
    'stagedSuccessCount',
    'stagedTotalMs',
    'totalRequests'
  ].sort()
  expect(Object.keys(snap.residentRead).sort()).toEqual(allowedRead)
  for (const [k, v] of Object.entries(snap.residentRead)) {
    if (k === 'stagedLastMs' || k === 'stagedAvgMs') {
      expect(v === null || typeof v === 'number').toBe(true)
      if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true)
    } else {
      expect(typeof v).toBe('number')
      expect(Number.isFinite(v as number)).toBe(true)
    }
  }

  // Reject unknown nested non-scalar/arrays/objects except explicit allowlists
  function recurse(val: unknown, path: string) {
    if (val === null) return
    if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'string') {
      // strings already checked for sentinels via serialized; trimmedEdge is only allowed string
      if (typeof val === 'string') {
        // Only trimmedEdge may be string; ensure no sentinel leaked
        for (const s of sentinels) expect(val).not.toContain(s)
      }
      return
    }
    if (Array.isArray(val)) {
      throw new Error(`Unexpected array at ${path}`)
    }
    if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        // Ensure no unknown keys beyond allowlists already checked; still recurse values
        recurse(v, `${path}.${k}`)
      }
      return
    }
    throw new Error(`Unexpected type at ${path}: ${typeof val}`)
  }
  recurse(snap, 'snap')
}

describe('Phase 4 exercised-workload validation increment (B-06/B-07/B-08/B-09)', () => {
  beforeEach(() => {
    store = new Map()
    ;(window as any).keyv = createKeyvMock()
    if (typeof window.requestAnimationFrame !== 'function') {
      ;(window as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0) as unknown as number
    }
    if (typeof window.cancelAnimationFrame !== 'function') {
      ;(window as any).cancelAnimationFrame = (id: number) => clearTimeout(id)
    }
    if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
      ;(globalThis as any).requestAnimationFrame = (window as any).requestAnimationFrame
    }
    if (typeof (globalThis as any).cancelAnimationFrame !== 'function') {
      ;(globalThis as any).cancelAnimationFrame = (window as any).cancelAnimationFrame
    }
    resetScrollSnapshotCacheForTests()
    resetScrollSnapshotDiagnosticsForTests()
    resetAllClosureStateForTests()
    resetContextClosureDiagnosticsForTests()
    resetContentSearchDiagnosticsForTests()
    resetResidentReadDiagnosticsForTests()
    highlightsMock.clear.mockClear()
    highlightsMock.set.mockClear()
    highlightArgs = []
  })

  it('coherent persistent-like mixed workload proves each bound through public boundaries and privacy-safe snapshot composition', async () => {
    // -----------------------------------------------------------------------
    // B-06: viewport group bound — public messageWindow API, persistent-like navigation with exact anchor preservation
    // -----------------------------------------------------------------------
    const CAL = MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT
    expect(CAL).toBe(200)
    expect(SCROLL_SNAPSHOT_MAX_COUNT).toBe(256)
    expect(SCROLL_SNAPSHOT_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000)

    const allMessages = users(500)
    // Latest window capped at 200 groups (m300..m499)
    let win = createLatestMessageWindow(allMessages, 500)
    expect(win.groupCount).toBeLessThanOrEqual(CAL)
    expect(win.groupCapacity).toBeLessThanOrEqual(CAL)
    expect(win.displayGroups.length).toBe(win.groupCount)
    expect(win.oldestMessageId).toBe('m300')
    expect(win.newestMessageId).toBe('m499')
    // Cross-check diagnostic adapter reflects same bound without hidden retention
    let b06 = getB06Diagnostics(win)
    expect(b06).not.toBeNull()
    expect(b06!.calibrationDefault).toBe(CAL)
    expect(b06!.boundedCapacity).toBeLessThanOrEqual(CAL)
    expect(b06!.groupCount).toBeLessThanOrEqual(CAL)

    // Persistent-like expansion: older 4x 40 groups — capture visible anchors before each trim, assert exact IDs remain
    const latestInitialOldest = win.oldestMessageId! // anchor before any older expansion
    expect(latestInitialOldest).toBe('m300')
    for (let i = 0; i < 4; i++) {
      const beforeOldest = win.oldestMessageId!
      const beforeNewest = win.newestMessageId!
      const beforeCount = win.groupCount
      win = expandMessageWindowOlder(allMessages, win, 40)
      expect(win.groupCount).toBeLessThanOrEqual(CAL)
      expect(win.displayGroups.length).toBe(win.groupCount)
      // When trim occurs (provisional >200), opposite edge (newer) trimmed but beforeOldest must remain
      if (win.boundedViewportObservability?.didTrim) {
        expect(win.boundedViewportObservability.trimmedEdge).toBe('newer')
        expect(win.boundedViewportObservability.trimmedGroups).toBeGreaterThan(0)
        // Exact ID preservation: previous oldest anchor remains in post-trim window
        expect(win.displayGroups.some((g) => g.messages.some((m) => m.id === beforeOldest))).toBe(true)
        // Also verify newest before is gone when trimmed (deterministic opposite-edge)
        // At bound, newest should have moved older
        expect(win.newestMessageId).not.toBe(beforeNewest)
      } else {
        // Before bound, no trim, window should have grown
        expect(win.groupCount).toBeGreaterThan(beforeCount)
      }
    }
    // At bound, older expansion must have trimmed newer edge deterministically
    b06 = getB06Diagnostics(win)
    expect(b06!.didTrim).toBe(true)
    expect(b06!.trimmedEdge).toBe('newer')
    expect(b06!.trimmedGroups).toBeGreaterThan(0)
    // Anchor preservation: initial latest anchor m300 still present after all older trims (exact ID)
    expect(win.displayGroups.some((g) => g.messages.some((m) => m.id === latestInitialOldest))).toBe(true)

    // Newer expansion path from oldest — capture anchors before each newer trim
    let win2 = createOldestMessageWindow(allMessages, CAL)
    expect(win2.groupCount).toBeLessThanOrEqual(CAL)
    expect(win2.oldestMessageId).toBe('m0')
    expect(win2.newestMessageId).toBe('m199')
    const oldestInitialNewest = win2.newestMessageId! // anchor before newer expansion
    expect(oldestInitialNewest).toBe('m199')
    for (let i = 0; i < 4; i++) {
      const beforeOldest = win2.oldestMessageId!
      const beforeNewest = win2.newestMessageId!
      const beforeCount = win2.groupCount
      win2 = expandMessageWindowNewer(allMessages, win2, 40)
      expect(win2.groupCount).toBeLessThanOrEqual(CAL)
      if (win2.boundedViewportObservability?.didTrim) {
        expect(win2.boundedViewportObservability.trimmedEdge).toBe('older')
        expect(win2.boundedViewportObservability.trimmedGroups).toBeGreaterThan(0)
        // Exact ID preservation: previous newest anchor remains in post-trim window
        expect(win2.displayGroups.some((g) => g.messages.some((m) => m.id === beforeNewest))).toBe(true)
        expect(win2.oldestMessageId).not.toBe(beforeOldest)
      } else {
        expect(win2.groupCount).toBeGreaterThan(beforeCount)
      }
    }
    const b06b = getB06Diagnostics(win2)
    expect(b06b!.didTrim).toBe(true)
    expect(b06b!.trimmedEdge).toBe('older')
    // Initial oldest window newest anchor still present after newer trims
    expect(win2.displayGroups.some((g) => g.messages.some((m) => m.id === oldestInitialNewest))).toBe(true)

    // Target window with over-capacity quotas must deterministically cap and preserve anchor
    const targetWin = createTargetMessageWindow(allMessages, 'm250', 120, 120)
    expect(targetWin.groupCount).toBeLessThanOrEqual(CAL)
    expect(targetWin.displayGroups.some((g) => g.messages.some((m) => m.id === 'm250'))).toBe(true)

    // Reconcile retains boundedness and does not evict entities (displayMessages sane)
    const reconciled = reconcileMessageWindow(allMessages, users(500), win)
    expect(reconciled.groupCount).toBeLessThanOrEqual(CAL)
    expect(reconciled.displayGroups.length).toBe(reconciled.groupCount)

    // No-entity-eviction invariant: viewport trim never changes authoritative count (groupCount bounded, not message eviction)
    expect(allMessages.length).toBe(500)
    expect(win.groupCount).toBeLessThanOrEqual(CAL)

    // -----------------------------------------------------------------------
    // B-07: scroll snapshot bounded index — public Keyv + index APIs with identity, recency, tie-break
    // -----------------------------------------------------------------------
    // Simulate persistent workload: 300 topic snapshots over time (exceeds 256) — assert expected LRU identities
    for (let i = 0; i < 300; i++) {
      const key = `scroll:topic-${String(i).padStart(3, '0')}`
      store.set(key, { scrollTop: -i, anchorId: null, isAtBottom: false })
      handleScrollSnapshotSaved(key, FIXED_NOW + i * 10)
    }
    let b07 = getScrollSnapshotDiagnostics()
    expect(b07.indexCount).toBeLessThanOrEqual(256)
    expect(b07.maxCount).toBe(256)
    expect(b07.ttlMs).toBe(SCROLL_SNAPSHOT_TTL_MS)
    expect(b07.lastEnforcement).not.toBeNull()
    expect(b07.lastEnforcement!.lruEvicted).toBe(1)
    expect(b07.lastEnforcement!.indexCountAfter).toBe(256)
    // Expected LRU eviction identities: cumulative 44 oldest evicted, newest survival
    expect(store.has('scroll:topic-000')).toBe(false)
    expect(store.has('scroll:topic-043')).toBe(false)
    expect(store.has('scroll:topic-044')).toBe(true)
    expect(store.has('scroll:topic-255')).toBe(true)
    expect(store.has('scroll:topic-299')).toBe(true)

    // Touch recency: touching oldest should make it survive next eviction
    resetScrollSnapshotCacheForTests()
    resetScrollSnapshotDiagnosticsForTests()
    store = new Map()
    ;(window as any).keyv = createKeyvMock()
    for (let i = 0; i < 256; i++) {
      const k = `scroll:topic-touch-${String(i).padStart(3, '0')}`
      store.set(k, { scrollTop: -i, anchorId: null, isAtBottom: false })
      handleScrollSnapshotSaved(k, FIXED_NOW + i * 10)
    }
    expect(getScrollSnapshotDiagnostics().indexCount).toBe(256)
    // Touch oldest (000) via save to bump lastAccess to newest
    handleScrollSnapshotSaved('scroll:topic-touch-000', FIXED_NOW + 100000)
    // Add new topic forcing one LRU eviction — untouched 001 should be evicted, touched 000 survives
    store.set('scroll:topic-touch-new', { scrollTop: -999, anchorId: null, isAtBottom: false })
    handleScrollSnapshotSaved('scroll:topic-touch-new', FIXED_NOW + 100001)
    b07 = getScrollSnapshotDiagnostics()
    expect(b07.indexCount).toBeLessThanOrEqual(256)
    expect(b07.lastEnforcement!.lruEvicted).toBe(1)
    expect(store.has('scroll:topic-touch-000')).toBe(true)
    expect(store.has('scroll:topic-touch-001')).toBe(false)
    expect(store.has('scroll:topic-touch-new')).toBe(true)

    // Save recency via read: read should also bump lastAccess
    resetScrollSnapshotCacheForTests()
    resetScrollSnapshotDiagnosticsForTests()
    store = new Map()
    ;(window as any).keyv = createKeyvMock()
    for (let i = 0; i < 256; i++) {
      const k = `scroll:topic-read-${String(i).padStart(3, '0')}`
      store.set(k, { scrollTop: -i, anchorId: null, isAtBottom: false })
      handleScrollSnapshotSaved(k, FIXED_NOW + i * 10)
    }
    // Read oldest to bump recency
    handleScrollSnapshotRead('scroll:topic-read-000', FIXED_NOW + 200000)
    store.set('scroll:topic-read-new', { scrollTop: -999, anchorId: null, isAtBottom: false })
    handleScrollSnapshotSaved('scroll:topic-read-new', FIXED_NOW + 200001)
    expect(store.has('scroll:topic-read-000')).toBe(true)
    expect(store.has('scroll:topic-read-001')).toBe(false)
    expect(store.has('scroll:topic-read-new')).toBe(true)

    // Deterministic equal-timestamp tie-break: lexicographically smallest evicted
    resetScrollSnapshotCacheForTests()
    resetScrollSnapshotDiagnosticsForTests()
    store = new Map()
    ;(window as any).keyv = createKeyvMock()
    for (let i = 0; i < 257; i++) {
      const k = `scroll:topic-tie-${String(i).padStart(3, '0')}`
      store.set(k, { scrollTop: -i, anchorId: null, isAtBottom: false })
    }
    const tieIdx = Array.from({ length: 257 }, (_, i) => ({
      key: `scroll:topic-tie-${String(i).padStart(3, '0')}`,
      lastAccess: FIXED_NOW
    }))
    store.set('scroll:__index__', tieIdx)
    enforceScrollSnapshotBounds(FIXED_NOW)
    b07 = getScrollSnapshotDiagnostics()
    expect(b07.indexCount).toBe(256)
    expect(b07.lastEnforcement!.lruEvicted).toBe(1)
    expect(store.has('scroll:topic-tie-000')).toBe(false)
    expect(store.has('scroll:topic-tie-001')).toBe(true)
    expect(store.has('scroll:topic-tie-256')).toBe(true)

    // TTL: craft 5 expired entries with old lastAccess, ensure TTL purges them via public enforce
    resetScrollSnapshotCacheForTests()
    resetScrollSnapshotDiagnosticsForTests()
    store = new Map()
    ;(window as any).keyv = createKeyvMock()
    const freshKeys: string[] = []
    for (let i = 0; i < 10; i++) {
      const k = `scroll:topic-fresh-${i}`
      freshKeys.push(k)
      store.set(k, { scrollTop: -i, anchorId: null, isAtBottom: false })
      handleScrollSnapshotSaved(k, FIXED_NOW)
    }
    const expiredKeys: string[] = []
    for (let i = 0; i < 5; i++) {
      const k = `scroll:topic-expired-${i}`
      expiredKeys.push(k)
      store.set(k, { scrollTop: -i, anchorId: null, isAtBottom: false })
    }
    const idxWithExpired = [...freshKeys, ...expiredKeys].map((k) => ({
      key: k,
      lastAccess: expiredKeys.includes(k) ? FIXED_NOW - SCROLL_SNAPSHOT_TTL_MS - 1000 : FIXED_NOW
    }))
    store.set('scroll:__index__', idxWithExpired)
    enforceScrollSnapshotBounds(FIXED_NOW)
    b07 = getScrollSnapshotDiagnostics()
    expect(b07.lastEnforcement!.expiredRemoved).toBeGreaterThanOrEqual(5)
    expect(expiredKeys.every((k) => store.get(k) === undefined)).toBe(true)
    expect(b07.indexCount).toBeLessThanOrEqual(256)

    // Rebuild/repair: corrupt index with duplicates + non-topic malformed, enforce via public boundary
    resetScrollSnapshotCacheForTests()
    resetScrollSnapshotDiagnosticsForTests()
    store = new Map()
    ;(window as any).keyv = createKeyvMock()
    store.set('scroll:topic-dup', { scrollTop: -1, anchorId: null, isAtBottom: false })
    store.set('scroll:topic-other', { scrollTop: -2, anchorId: null, isAtBottom: false })
    store.set('scroll:__index__', [
      { key: 'scroll:topic-dup', lastAccess: FIXED_NOW },
      { key: 'scroll:topic-dup', lastAccess: FIXED_NOW - 1000 },
      { key: 'scroll:topic-other', lastAccess: FIXED_NOW },
      { key: 'scroll:SearchResults', lastAccess: FIXED_NOW },
      { key: '', lastAccess: FIXED_NOW }
    ])
    enforceScrollSnapshotBounds(FIXED_NOW)
    const b07AfterRepair = getScrollSnapshotDiagnostics()
    expect(b07AfterRepair.lastEnforcement!.indexCountBefore).toBe(5)
    expect(b07AfterRepair.lastEnforcement!.didRebuild).toBe(true)
    expect(b07AfterRepair.indexCount).toBe(2)

    // Hard-delete invalidation: public removeScrollSnapshotsForTopicIds durably blocks recreation
    store.set('scroll:topic-to-delete', { scrollTop: -1, anchorId: null, isAtBottom: false })
    handleScrollSnapshotSaved('scroll:topic-to-delete', FIXED_NOW)
    expect(store.has('scroll:topic-to-delete')).toBe(true)
    removeScrollSnapshotsForTopicIds(['to-delete'])
    expect(store.has('scroll:topic-to-delete')).toBe(false)
    handleScrollSnapshotSaved('scroll:topic-to-delete', FIXED_NOW + 100)
    expect(store.has('scroll:topic-to-delete')).toBe(false)

    // Sentinel privacy for B-07: ensure sentinel topic not leaked in snapshot
    const sentinelScrollKey = `scroll:topic-${SENTINEL_TOPIC}`
    store.set(sentinelScrollKey, { scrollTop: -1, anchorId: SENTINEL_CONTENT, isAtBottom: false })
    handleScrollSnapshotSaved(sentinelScrollKey, FIXED_NOW + 500000)
    // snapshot must not contain sentinel even though stored
    const b07SentinelSnap = getPhase4Snapshot(win)
    expect(JSON.stringify(b07SentinelSnap.b07)).not.toContain(SENTINEL_TOPIC)
    expect(JSON.stringify(b07SentinelSnap.b07)).not.toContain(SENTINEL_CONTENT)
    // cleanup sentinel to keep bounded
    removeScrollSnapshotsForTopicIds([SENTINEL_TOPIC])
    // SENTINEL_PATH exercised via disposable scroll snapshot value (transient anchorId, scalar-only snapshot must not leak)
    const sentinelPathKey = `scroll:topic-path-sentinel`
    store.set(sentinelPathKey, { scrollTop: -1, anchorId: SENTINEL_PATH, isAtBottom: false })
    handleScrollSnapshotSaved(sentinelPathKey, FIXED_NOW + 500010)
    expect(JSON.stringify(getPhase4Snapshot(win).b07)).not.toContain(SENTINEL_PATH)
    removeScrollSnapshotsForTopicIds(['path-sentinel'])
    // SENTINEL_HISTORY exercised via disposable scroll snapshot value (disposable history-like anchor, scalar snapshot must not leak)
    const sentinelHistoryKey = `scroll:topic-history-sentinel`
    store.set(sentinelHistoryKey, { scrollTop: -1, anchorId: SENTINEL_HISTORY, isAtBottom: false })
    handleScrollSnapshotSaved(sentinelHistoryKey, FIXED_NOW + 500020)
    expect(JSON.stringify(getPhase4Snapshot(win).b07)).not.toContain(SENTINEL_HISTORY)
    removeScrollSnapshotsForTopicIds(['history-sentinel'])

    // -----------------------------------------------------------------------
    // B-09: context-closure active-topic retention — public retention + validation API with identity/generation
    // -----------------------------------------------------------------------
    resetAllClosureStateForTests()
    resetContextClosureDiagnosticsForTests()
    for (let i = 0; i < 5; i++) {
      const tid = `t-b09-${i}`
      const fp = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: tid, blocks: [] }] as any)
      setCachedContextClosureWithFingerprint(tid, makeClosureResp(tid, 'u1'), fp)
    }
    expect(getContextClosureDiagnostics().retainedTopicCount).toBe(5)
    expect(getAllCachedTopicIds().sort()).toEqual(['t-b09-0', 't-b09-1', 't-b09-2', 't-b09-3', 't-b09-4'].sort())
    enforceContextClosureRetention('t-b09-2')
    const b09 = getContextClosureDiagnostics()
    expect(b09.retainedTopicCount).toBeLessThanOrEqual(1)
    expect(b09.maxRetainedTopics).toBe(1)
    expect(b09.retainedTopicCount).toBe(1)
    // Identity: active retained, inactive removed (exact)
    expect(getCachedContextClosure('t-b09-2')).not.toBeNull()
    expect(getAllCachedTopicIds()).toEqual(['t-b09-2'])
    expect(getCachedContextClosure('t-b09-0')).toBeNull()
    expect(getCachedContextClosure('t-b09-1')).toBeNull()
    expect(getCachedContextClosure('t-b09-3')).toBeNull()
    expect(getCachedContextClosure('t-b09-4')).toBeNull()

    // Hit/miss via public getFreshValidatedClosure (same workload)
    resetContextClosureDiagnosticsForTests()
    const active = 't-b09-active'
    const fpActive = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: active, blocks: [] }] as any)
    setCachedContextClosureWithFingerprint(active, makeClosureResp(active, 'u1'), fpActive)
    enforceContextClosureRetention(active)
    expect(getFreshValidatedClosure(active, 'u1', fpActive)).not.toBeNull()
    expect(getFreshValidatedClosure(active, 'wrong-anchor', fpActive)).toBeNull()
    expect(getFreshValidatedClosure('t-missing', 'u1', fpActive)).toBeNull()
    const fpWrong = computeClosureFingerprint([
      { id: 'u1', role: 'user', topicId: active, status: 'pending', blocks: [] }
    ] as any)
    expect(fpWrong).not.toBe(fpActive)
    expect(getFreshValidatedClosure(active, 'u1', fpWrong)).toBeNull()

    // Generation bump invalidates distinct from retention: publish, bump, then miss
    const fpBeforeBump = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: active, blocks: [] }] as any)
    setCachedContextClosureWithFingerprint(active, makeClosureResp(active, 'u1'), fpBeforeBump)
    const genBeforeBump = getCurrentClosureGeneration(active)
    const cachedGenBefore = getCachedClosureGeneration(active)
    expect(cachedGenBefore).toBe(genBeforeBump)
    bumpClosureGeneration(active)
    const genAfterBump = getCurrentClosureGeneration(active)
    expect(genAfterBump).toBe(genBeforeBump + 1)
    expect(getFreshValidatedClosure(active, 'u1', fpBeforeBump)).toBeNull()

    // Deletion invalidation via public bumpAndInvalidate — advances generation and stale rejected
    const delTopic = `t-del-${SENTINEL_TOPIC}`
    const fpDel = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: delTopic, blocks: [] }] as any)
    setCachedContextClosureWithFingerprint(delTopic, makeClosureResp(delTopic, 'u1'), fpDel)
    expect(getFreshValidatedClosure(delTopic, 'u1', fpDel)).not.toBeNull()
    const genDelBefore = getCurrentClosureGeneration(delTopic)
    const cachedGenDelBefore = getCachedClosureGeneration(delTopic)
    expect(cachedGenDelBefore).toBe(genDelBefore)
    bumpAndInvalidate(delTopic)
    const genDelAfter = getCurrentClosureGeneration(delTopic)
    expect(genDelAfter).toBe(genDelBefore + 1)
    expect(getCachedContextClosure(delTopic)).toBeNull()
    expect(getCachedClosureGeneration(delTopic)).toBeUndefined()
    expect(getFreshValidatedClosure(delTopic, 'u1', fpDel)).toBeNull()
    // stale fingerprint with old generation must still be rejected even if we try to re-validate
    expect(getFreshValidatedClosure(delTopic, 'u1', fpDel)).toBeNull()
    expect(getContextClosureDiagnostics().hitCount).toBe(2)
    expect(getContextClosureDiagnostics().missCount).toBeGreaterThanOrEqual(6)
    // SENTINEL_CREDENTIAL exercised via disposable context-closure cache entry (transient message id/fingerprint, scalar snapshot must not leak)
    const credTopic = 't-cred-sentinel'
    const credFingerprintInput = [
      { id: SENTINEL_CREDENTIAL, role: 'user', topicId: credTopic, blocks: [SENTINEL_CREDENTIAL] }
    ] as any
    const fpCred = computeClosureFingerprint(credFingerprintInput)
    const credResp = makeClosureResp(credTopic, SENTINEL_CREDENTIAL, [SENTINEL_CREDENTIAL])
    setCachedContextClosureWithFingerprint(credTopic, credResp, fpCred)
    expect(getFreshValidatedClosure(credTopic, SENTINEL_CREDENTIAL, fpCred)).not.toBeNull()
    expect(JSON.stringify(getPhase4Snapshot(win).b09)).not.toContain(SENTINEL_CREDENTIAL)
    bumpAndInvalidate(credTopic)
    expect(getCachedContextClosure(credTopic)).toBeNull()

    // -----------------------------------------------------------------------
    // B-08: ContentSearch disposable session — actual component/DOM Range lifecycle (>500 matches/chunks, owner replacement/navigation, unmount)
    // -----------------------------------------------------------------------
    resetContentSearchDiagnosticsForTests()
    const filter = makeFilter()
    // Large DOM: 650 containers *2 matches =1300 total => 3 chunks (500,500,300)
    // Includes SENTINEL_CONTENT, SENTINEL_HISTORY and SENTINEL_PATH in transient DOM content (disposable, scalar snapshot must not leak)
    const target = document.createElement('div')
    target.innerHTML = Array.from({ length: 650 })
      .map(() => `<div>hello world ${SENTINEL_CONTENT} ${SENTINEL_HISTORY} ${SENTINEL_PATH} hello</div>`)
      .join('')
    document.body.appendChild(target)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    const { unmount: unmountPrimary } = render(
      React.createElement(ContentSearch, { ref: ref as any, searchTarget: target, filter, onClose: () => {} })
    )
    const host = screen.getByTestId('content-search-host')
    const input = screen.getByTestId('content-search').querySelector('input') as HTMLInputElement
    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(screen.getByTestId('content-search').textContent).toContain('1/1300'))

    let b08 = getContentSearchDiagnostics()
    expect(b08.liveRangeCount).toBeLessThanOrEqual(500)
    expect(b08.liveRangeCount).toBe(500)
    expect(b08.totalCount).toBe(1300)
    expect(b08.maxLiveRanges).toBe(500)
    expect(b08.chunkSize).toBe(500)
    expect(getActiveContentSearchOwnerForTests()).not.toBeNull()
    const primaryOwner = getActiveContentSearchOwnerForTests()!
    expect(Number(host.getAttribute('data-live-ranges'))).toBeLessThanOrEqual(500)
    // Privacy: DOM content with sentinel must not leak into diagnostics snapshot
    expect(JSON.stringify(b08)).not.toContain(SENTINEL_CONTENT)
    expect(JSON.stringify(b08)).not.toContain(SENTINEL_TOPIC)
    expect(JSON.stringify(b08)).not.toContain(SENTINEL_PATH)
    expect(JSON.stringify(b08)).not.toContain(SENTINEL_CREDENTIAL)
    expect(JSON.stringify(b08)).not.toContain(SENTINEL_HISTORY)

    // Cross-chunk navigation: advance to next chunk (501) — must rescan, live stays bounded
    const rescanBeforeChunk = b08.rescanCount
    for (let i = 0; i < 500; i++) {
      await act(async () => {
        ref.current?.searchNext()
      })
    }
    await waitFor(() => expect(screen.getByTestId('content-search').textContent).toContain('501/1300'))
    b08 = getContentSearchDiagnostics()
    expect(b08.liveRangeCount).toBeLessThanOrEqual(500)
    expect(b08.chunkIndex).toBe(1)
    expect(b08.rescanCount).toBeGreaterThan(rescanBeforeChunk)
    expect(Number(host.getAttribute('data-live-ranges'))).toBeLessThanOrEqual(500)

    // DOM mutation invalidation: add content then same-chunk navigation must trigger invalidation+rescan
    const invalidationBefore = b08.invalidationCount
    const rescanBeforeMutation = b08.rescanCount
    target.innerHTML += Array.from({ length: 200 })
      .map(() => '<div>hello hello</div>')
      .join('')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await act(async () => {
      ref.current?.searchNext()
    })
    await waitFor(() => {
      const txt = screen.getByTestId('content-search').textContent || ''
      expect(txt).toContain('/1700')
    })
    b08 = getContentSearchDiagnostics()
    expect(b08.invalidationCount).toBeGreaterThan(invalidationBefore)
    expect(b08.rescanCount).toBeGreaterThan(rescanBeforeMutation)
    expect(b08.totalCount).toBe(1700)
    expect(b08.liveRangeCount).toBeLessThanOrEqual(500)

    // Replacement isolation: mount B, verify B owns, stale A cannot overwrite, unmount cleanup
    const targetB = document.createElement('div')
    targetB.innerHTML = '<div>alpha beta alpha</div>'
    document.body.appendChild(targetB)
    const refB = { current: null as any } as React.RefObject<ContentSearchRef>
    const { unmount: unmountB } = render(
      React.createElement(ContentSearch, { ref: refB as any, searchTarget: targetB, filter, onClose: () => {} })
    )
    const inputB = screen.getAllByTestId('content-search').at(-1)!.querySelector('input') as HTMLInputElement
    inputB.value = 'alpha'
    await act(async () => {
      refB.current?.search()
    })
    await waitFor(() => expect(screen.getAllByTestId('content-search').at(-1)!.textContent).toContain('1/2'))
    b08 = getContentSearchDiagnostics()
    expect(b08.liveRangeCount).toBe(2)
    expect(b08.totalCount).toBe(2)
    const ownerB = getActiveContentSearchOwnerForTests()!
    expect(ownerB).not.toBe(primaryOwner)
    const snapshotB = { ...b08 }

    // Stale A search must not overwrite active B
    const inputA = screen.getAllByTestId('content-search')[0].querySelector('input') as HTMLInputElement
    inputA.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    b08 = getContentSearchDiagnostics()
    expect(b08.liveRangeCount).toBe(snapshotB.liveRangeCount)
    expect(b08.totalCount).toBe(snapshotB.totalCount)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerB)

    // Stale diagnostics writes must be rejected
    const beforeStale = { ...getContentSearchDiagnostics() }
    recordContentSearchCommit(primaryOwner, 999, 9, 9999, 999)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(beforeStale.liveRangeCount)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerB)
    recordContentSearchInvalidation(primaryOwner, 1001)
    expect(getContentSearchDiagnostics().invalidationCount).toBe(beforeStale.invalidationCount)
    recordContentSearchRescanIncrement(primaryOwner)
    expect(getContentSearchDiagnostics().rescanCount).toBe(beforeStale.rescanCount)

    // Stale release must not clear active B
    expect(releaseContentSearchSessionIfOwned(primaryOwner)).toBe(false)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(snapshotB.liveRangeCount)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerB)

    // Unmount active B clears live, stale B unmount no-op already tested via primary still active?
    // First unmount primary (stale) should not clear B — do it explicitly
    unmountPrimary()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(2)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerB)

    // Owning B unmount clears
    unmountB()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    b08 = getContentSearchDiagnostics()
    expect(b08.liveRangeCount).toBe(0)
    expect(b08.totalCount).toBe(0)
    expect(getActiveContentSearchOwnerForTests()).toBeNull()

    // Re-establish after release for final coherent snapshot
    const ownerC = createContentSearchSessionOwnerId()
    recordContentSearchCommit(ownerC, 2, 0, 2, 5)
    expect(getContentSearchDiagnostics().liveRangeCount).toBeLessThanOrEqual(500)

    document.body.removeChild(target)
    document.body.removeChild(targetB)

    // -----------------------------------------------------------------------
    // Resident lifecycle — public reducer + diagnostics adapter (no B-01..B-05)
    // -----------------------------------------------------------------------
    const residentStore = configureStore({ reducer: { residentRegistry: residentRegistryReducer } })
    const entries = (): Record<string, any> => (residentStore.getState() as any).residentRegistry.entries

    residentStore.dispatch(bumpGeneration('t-res-A'))
    const genA1 = entries()['t-res-A'].applicabilityGeneration as number
    expect(genA1).toBe(1)
    residentStore.dispatch(
      publishResidentComplete({
        topicId: 't-res-A',
        generation: genA1,
        windowResponse: makeWindowResponse('t-res-A', ['m1']),
        segments: []
      })
    )
    residentStore.dispatch(bumpGeneration('t-res-B'))
    const genB1 = entries()['t-res-B'].applicabilityGeneration as number
    residentStore.dispatch(
      publishResidentComplete({
        topicId: 't-res-B',
        generation: genB1,
        windowResponse: makeWindowResponse('t-res-B', ['m2']),
        segments: []
      })
    )
    let residentDiag = getResidentDiagnostics(entries())
    expect(residentDiag.entryCount).toBe(2)
    expect(residentDiag.residentCount).toBe(2)
    expect(residentDiag.incompleteCount).toBe(0)
    expect(residentDiag.maxGeneration).toBe(1)

    residentStore.dispatch(bumpGeneration('t-res-A'))
    const genA2 = entries()['t-res-A'].applicabilityGeneration as number
    expect(genA2).toBe(2)
    residentDiag = getResidentDiagnostics(entries())
    expect(residentDiag.residentCount).toBe(1)
    expect(residentDiag.incompleteCount).toBe(1)
    expect(residentDiag.maxGeneration).toBe(2)

    const stalePayload = {
      topicId: 't-res-A',
      generation: genA1,
      windowResponse: makeWindowResponse('t-res-A', ['m-stale']),
      segments: []
    }
    expect(shouldDiscardJointPublish(residentStore.getState(), stalePayload)).toBe(true)
    const beforeStaleResident = getResidentDiagnostics(entries())
    residentStore.dispatch(publishResidentComplete(stalePayload as any))
    expect(getResidentDiagnostics(entries())).toEqual(beforeStaleResident)

    residentStore.dispatch(
      publishResidentComplete({
        topicId: 't-res-A',
        generation: genA2,
        windowResponse: makeWindowResponse('t-res-A', ['m-good']),
        segments: []
      })
    )
    expect(getResidentDiagnostics(entries()).residentCount).toBe(2)
    expect(getResidentDiagnostics(entries()).incompleteCount).toBe(0)

    const genBBefore = entries()['t-res-B'].applicabilityGeneration
    residentStore.dispatch(invalidateForDeletion('t-res-B'))
    expect(entries()['t-res-B'].applicabilityGeneration).toBe(genBBefore + 1)
    expect(entries()['t-res-B'].residentTopic).toBe(false)
    residentStore.dispatch(clearResidentEntry('t-res-B'))
    expect(entries()['t-res-B']).toBeUndefined()
    residentStore.dispatch(resetAllResidentRegistry())
    expect(getResidentDiagnostics(entries()).entryCount).toBe(0)

    residentStore.dispatch(bumpGeneration('t-final'))
    const genFinal = entries()['t-final'].applicabilityGeneration
    residentStore.dispatch(
      publishResidentComplete({
        topicId: 't-final',
        generation: genFinal,
        windowResponse: makeWindowResponse('t-final', ['m1']),
        segments: []
      })
    )

    // -----------------------------------------------------------------------
    // Resident read-path — public scalar diagnostics, persistent-like mix
    // -----------------------------------------------------------------------
    resetResidentReadDiagnosticsForTests()
    recordResidentReadHit()
    recordResidentReadMiss('forced')
    recordResidentReadMiss('noIndex')
    recordResidentReadMiss('deletion')
    recordResidentReadMiss('legacyEmpty')
    recordResidentReadMiss('noEntry')
    recordResidentReadMiss('incomplete')
    recordStagedLatency(12, true)
    recordStagedLatency(5, false)
    recordResidentReadDiscard('superseded')
    recordResidentReadDiscard('generationMismatch')
    const readDiag = getResidentReadDiagnostics()
    expect(readDiag.hitCount).toBe(1)
    expect(readDiag.missCount).toBe(6)
    expect(readDiag.totalRequests).toBe(7)
    expect(readDiag.stagedCount).toBe(2)
    expect(readDiag.stagedSuccessCount).toBe(1)
    expect(readDiag.stagedFailedCount).toBe(1)
    expect(readDiag.stagedLastMs).not.toBeNull()
    expect(readDiag.stagedLastMs!).toBeGreaterThanOrEqual(0)
    expect(readDiag.stagedTotalMs).toBeGreaterThanOrEqual(0)
    expect(readDiag.stagedMaxMs).toBeGreaterThanOrEqual(0)
    expect(readDiag.discardedCount).toBe(2)
    expect(readDiag.discardedSuperseded).toBe(1)
    expect(readDiag.discardedGenerationMismatch).toBe(1)

    // -----------------------------------------------------------------------
    // Coherent snapshot — all bounds simultaneously, scalar-only, privacy-safe (recursive)
    // -----------------------------------------------------------------------
    const snap = getPhase4Snapshot(win, entries())
    expect(snap.b06).not.toBeNull()
    expect(snap.b06!.groupCount).toBeLessThanOrEqual(200)
    expect(snap.b06!.calibrationDefault).toBe(200)
    expect(snap.b06!.boundedCapacity).toBeLessThanOrEqual(200)
    expect(snap.b07.indexCount).toBeLessThanOrEqual(256)
    expect(snap.b07.maxCount).toBe(256)
    expect(snap.b07.ttlMs).toBe(SCROLL_SNAPSHOT_TTL_MS)
    expect(snap.b08.liveRangeCount).toBeLessThanOrEqual(500)
    expect(snap.b08.maxLiveRanges).toBe(500)
    expect(snap.b08.chunkSize).toBe(500)
    expect(snap.b09.retainedTopicCount).toBeLessThanOrEqual(1)
    expect(snap.b09.maxRetainedTopics).toBe(1)
    expect(snap.resident.entryCount).toBe(1)
    expect(snap.resident.residentCount).toBe(1)
    expect(snap.resident.maxGeneration).toBe(1)
    expect(snap.residentRead.hitCount).toBe(1)
    expect(snap.residentRead.missCount).toBe(6)
    expect(snap.residentRead.stagedCount).toBe(2)
    expect(snap.residentRead.discardedCount).toBe(2)

    const scalars = getPhase4BoundScalars(win, entries())
    expect(scalars.b06GroupCount).toBeLessThanOrEqual(200)
    expect(scalars.b07IndexCount).toBeLessThanOrEqual(256)
    expect(scalars.b08LiveRangeCount).toBeLessThanOrEqual(500)
    expect(scalars.b09Retained).toBeLessThanOrEqual(1)
    expect(scalars.residentEntryCount).toBe(1)
    expect(scalars.readHitCount).toBe(1)
    expect(scalars.readMissCount).toBe(6)
    expect(scalars.readStagedCount).toBe(2)
    expect(scalars.readDiscardedCount).toBe(2)

    // Recursive shape/value + sentinel privacy validation (replaces shallow substring/top-level checks)
    assertSnapshotPrivacySafe(snap, SENTINEL_IDS)
    // Also validate bound scalars composition does not leak sentinels
    expect(JSON.stringify(scalars)).not.toContain(SENTINEL_TOPIC)
    expect(JSON.stringify(scalars)).not.toContain(SENTINEL_CONTENT)
    expect(JSON.stringify(scalars)).not.toContain(SENTINEL_PATH)
    expect(JSON.stringify(scalars)).not.toContain(SENTINEL_CREDENTIAL)
    expect(JSON.stringify(scalars)).not.toContain(SENTINEL_HISTORY)

    // B-06..B-09 coexist without policy expansion or data retention (ENTRY counts stay bounded)
    expect(scalars.b06GroupCount!).toBeLessThanOrEqual(200)
    expect(scalars.b07IndexCount).toBeLessThanOrEqual(256)
    expect(scalars.b08LiveRangeCount).toBeLessThanOrEqual(500)
    expect(scalars.b09Retained).toBeLessThanOrEqual(1)

    // Cleanup B-08 owner to avoid leak for subsequent tests
    releaseContentSearchSessionIfOwned(ownerC)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(0)
  })

  it('B-07/B-08/B-09 bounds remain observable and privacy-safe when no window supplied', () => {
    store = new Map()
    ;(window as any).keyv = createKeyvMock()
    resetScrollSnapshotCacheForTests()
    resetScrollSnapshotDiagnosticsForTests()
    resetAllClosureStateForTests()
    resetContentSearchDiagnosticsForTests()

    const fp = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: 't-x', blocks: [] }] as any)
    setCachedContextClosureWithFingerprint('t-x', makeClosureResp('t-x', 'u1'), fp)
    handleScrollSnapshotSaved('scroll:topic-t-x', FIXED_NOW)
    // Sentinel scroll key to prove privacy
    const sentinelKey = `scroll:topic-${SENTINEL_TOPIC}`
    store.set(sentinelKey, { scrollTop: -1, anchorId: SENTINEL_CONTENT, isAtBottom: false })
    handleScrollSnapshotSaved(sentinelKey, FIXED_NOW + 1000)
    removeScrollSnapshotsForTopicIds([SENTINEL_TOPIC])
    // Exercise remaining sentinels via disposable transient inputs (path/history via scroll, credential via closure)
    const sentinelPathKey2 = `scroll:topic-path-sentinel-2`
    store.set(sentinelPathKey2, { scrollTop: -1, anchorId: SENTINEL_PATH, isAtBottom: false })
    handleScrollSnapshotSaved(sentinelPathKey2, FIXED_NOW + 2000)
    removeScrollSnapshotsForTopicIds(['path-sentinel-2'])
    const sentinelHistoryKey2 = `scroll:topic-history-sentinel-2`
    store.set(sentinelHistoryKey2, { scrollTop: -1, anchorId: SENTINEL_HISTORY, isAtBottom: false })
    handleScrollSnapshotSaved(sentinelHistoryKey2, FIXED_NOW + 3000)
    removeScrollSnapshotsForTopicIds(['history-sentinel-2'])
    const credTopic2 = 't-cred-sentinel-2'
    const fpCred2 = computeClosureFingerprint([
      { id: SENTINEL_CREDENTIAL, role: 'user', topicId: credTopic2, blocks: [SENTINEL_CREDENTIAL] }
    ] as any)
    setCachedContextClosureWithFingerprint(
      credTopic2,
      makeClosureResp(credTopic2, SENTINEL_CREDENTIAL, [SENTINEL_CREDENTIAL]),
      fpCred2
    )
    expect(getFreshValidatedClosure(credTopic2, SENTINEL_CREDENTIAL, fpCred2)).not.toBeNull()
    bumpAndInvalidate(credTopic2)

    const snap = getPhase4Snapshot(null)
    expect(snap.b06).toBeNull()
    expect(snap.b07.indexCount).toBeLessThanOrEqual(256)
    expect(snap.b08.liveRangeCount).toBeLessThanOrEqual(500)
    expect(snap.b09.retainedTopicCount).toBeLessThanOrEqual(1)
    const scalars = getPhase4BoundScalars(null)
    expect(scalars.b06GroupCount).toBeNull()
    expect(scalars.b07IndexCount).toBeLessThanOrEqual(256)
    assertSnapshotPrivacySafe(snap, SENTINEL_IDS)
    expect(JSON.stringify(snap)).not.toContain('t-x')
    expect(JSON.stringify(snap)).not.toContain('u1')
  })
})
