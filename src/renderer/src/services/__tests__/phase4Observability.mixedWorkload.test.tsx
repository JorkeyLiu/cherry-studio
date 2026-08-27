/**
 * Phase 4 mixed-workload observability regression tests — local diagnostics only.
 *
 * Exercises B-06/B-07/B-08/B-09 under realistic synthetic pressure and asserts
 * coherent diagnostic snapshot bounds and observability tracking.
 *
 * Local-only, no network, no IPC/shared, no SQLite, no B-01..B-05.
 * Phase 4 exit remains Open; this is exercised-workload/observability evidence only.
 */

import { ContentSearch, type ContentSearchRef } from '@renderer/components/ContentSearch'
import {
  createContentSearchSessionOwnerId,
  getActiveContentSearchOwnerForTests,
  getContentSearchDiagnostics,
  recordContentSearchClear,
  recordContentSearchCommit,
  recordContentSearchInvalidation,
  recordContentSearchRescanIncrement,
  releaseContentSearchSessionIfOwned,
  resetContentSearchDiagnosticsForTests
} from '@renderer/components/contentSearchDiagnostics'
import {
  createLatestMessageWindow,
  createOldestMessageWindow,
  expandMessageWindowNewer,
  expandMessageWindowOlder,
  MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT
} from '@renderer/pages/home/Messages/messageWindow'
import {
  computeClosureFingerprint,
  type ContextClosureDiagnostics,
  enforceContextClosureRetention,
  getContextClosureDiagnostics,
  getFreshValidatedClosure,
  resetAllClosureStateForTests,
  resetContextClosureDiagnosticsForTests,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import { getB06Diagnostics, getPhase4Snapshot } from '@renderer/services/phase4Observability'
import {
  enforceScrollSnapshotBounds,
  getScrollSnapshotDiagnostics,
  handleScrollSnapshotSaved,
  resetScrollSnapshotCacheForTests,
  resetScrollSnapshotDiagnosticsForTests,
  SCROLL_SNAPSHOT_TTL_MS
} from '@renderer/services/scrollSnapshotCache'
import type { Message } from '@renderer/types/newMessage'
import { AssistantMessageStatus, UserMessageStatus } from '@renderer/types/newMessage'
import type { FetchContextClosureResponse } from '@shared/chatDb'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stub CSS.highlights and Highlight for jsdom (ContentSearch)
const highlightsMock = { clear: vi.fn(), set: vi.fn(), delete: vi.fn() }
// @ts-ignore
global.CSS = global.CSS || {}
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

function makeResp(topicId = 't1', anchor = 'u1', ids: string[] = ['u1', 'a1', 'u2']): FetchContextClosureResponse {
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

// Keyv mock for B-07
let store: Map<string, unknown>
function createKeyvMock() {
  return {
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown) => store.set(k, v),
    remove: (k: string) => store.delete(k),
    keys: () => Array.from(store.keys())
  }
}

describe('Phase 4 mixed-workload observability (B-06/B-07/B-08/B-09)', () => {
  beforeEach(() => {
    store = new Map()
    // Preserve jsdom window methods (requestAnimationFrame etc.) by mutating existing window.keyv instead of stubbing whole window
    ;(window as any).keyv = createKeyvMock()
    // Polyfill cancelAnimationFrame/requestAnimationFrame for jsdom/AntD motion if missing
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
    highlightsMock.clear.mockClear()
    highlightsMock.set.mockClear()
    highlightArgs = []
  })

  it('B-06: never exceeds 200 groups and has opposite-edge trim evidence under pressure', () => {
    const CAL = MESSAGE_WINDOW_VIEWPORT_CAPACITY_CALIBRATION_DEFAULT
    expect(CAL).toBe(200)
    const messages = users(500)
    // initial latest window capped
    let win = createLatestMessageWindow(messages, 500)
    expect(win.groupCount).toBeLessThanOrEqual(200)
    expect(win.groupCapacity).toBeLessThanOrEqual(200)
    // repeated older expansion pressure (5 x 50)
    for (let i = 0; i < 5; i++) {
      win = expandMessageWindowOlder(messages, win, 50)
      expect(win.groupCount).toBeLessThanOrEqual(200)
    }
    // at least one expansion must have trimmed opposite edge (newer) when at bound
    // verify via coherent snapshot adapter
    const b06 = getB06Diagnostics(win)
    expect(b06).not.toBeNull()
    expect(b06!.groupCount).toBeLessThanOrEqual(200)
    expect(b06!.calibrationDefault).toBe(200)
    // The last win after pressure should have didTrim true (since we expanded beyond bound multiple times)
    expect(b06!.didTrim).toBe(true)
    expect(b06!.trimmedEdge).toBe('newer')
    expect(b06!.trimmedGroups).toBeGreaterThan(0)

    // also exercise newer direction from oldest
    let win2 = createOldestMessageWindow(messages, CAL)
    expect(win2.groupCount).toBeLessThanOrEqual(200)
    for (let i = 0; i < 5; i++) {
      win2 = expandMessageWindowNewer(messages, win2, 50)
      expect(win2.groupCount).toBeLessThanOrEqual(200)
    }
    const b06b = getB06Diagnostics(win2)
    expect(b06b!.didTrim).toBe(true)
    expect(b06b!.trimmedEdge).toBe('older')

    // coherent snapshot does not retain message content
    const snap = getPhase4Snapshot(win)
    const serialized = JSON.stringify(snap)
    // ensure no message ids content leak as bounded diagnostics (but ids like m0 appear in window? snapshot should not contain them)
    // snapshot contains only scalars, not message content — verify no raw message text fields
    expect(serialized).not.toContain('blocks')
    expect(serialized).not.toContain('createdAt')
    // B-06 diagnostic pattern present
    expect(snap.b06).not.toBeNull()
    expect(snap.b06!.groupCount).toBeLessThanOrEqual(200)
  })

  it('B-07: index stays <=256 with observable TTL/LRU results under mixed pressure', () => {
    const now = Date.now()
    // pressure: save 300 topic snapshots (exceeds 256)
    for (let i = 0; i < 300; i++) {
      const key = `scroll:topic-${String(i).padStart(3, '0')}`
      store.set(key, { scrollTop: -i, anchorId: null, isAtBottom: false })
      handleScrollSnapshotSaved(key, now + i * 10)
    }
    let diag = getScrollSnapshotDiagnostics()
    expect(diag.indexCount).toBeLessThanOrEqual(256)
    expect(diag.maxCount).toBe(256)
    expect(diag.ttlMs).toBe(SCROLL_SNAPSHOT_TTL_MS)
    // last enforcement should show LRU eviction occurred
    expect(diag.lastEnforcement).not.toBeNull()
    expect(diag.lastEnforcement!.lruEvicted).toBeGreaterThan(0)
    expect(diag.lastEnforcement!.indexCountAfter).toBeLessThanOrEqual(256)
    // coherent snapshot reflects same
    const snap = getPhase4Snapshot(null)
    expect(snap.b07.indexCount).toBeLessThanOrEqual(256)

    // TTL pressure: add 10 fresh + 5 expired entries, then enforce
    resetScrollSnapshotCacheForTests()
    resetScrollSnapshotDiagnosticsForTests()
    store = new Map()
    ;(window as any).keyv = createKeyvMock()
    const freshKeys: string[] = []
    for (let i = 0; i < 10; i++) {
      const k = `scroll:topic-fresh-${i}`
      freshKeys.push(k)
      store.set(k, { scrollTop: -i, anchorId: null, isAtBottom: false })
      handleScrollSnapshotSaved(k, now)
    }
    // manually craft expired entries with old lastAccess
    const expiredKeys: string[] = []
    for (let i = 0; i < 5; i++) {
      const k = `scroll:topic-expired-${i}`
      expiredKeys.push(k)
      store.set(k, { scrollTop: -i, anchorId: null, isAtBottom: false })
    }
    // Build index with expired timestamps
    const idx = [...freshKeys, ...expiredKeys].map((k) => ({
      key: k,
      lastAccess: expiredKeys.includes(k) ? now - SCROLL_SNAPSHOT_TTL_MS - 1000 : now
    }))
    store.set('scroll:__index__', idx)
    enforceScrollSnapshotBounds(now)
    diag = getScrollSnapshotDiagnostics()
    expect(diag.lastEnforcement!.expiredRemoved).toBeGreaterThanOrEqual(5)
    expect(expiredKeys.every((k) => store.get(k) === undefined)).toBe(true)
    expect(diag.indexCount).toBeLessThanOrEqual(256)
    // reset safely without losing durable format
    resetScrollSnapshotDiagnosticsForTests()
    expect(getScrollSnapshotDiagnostics().lastEnforcement).toBeNull()
    // index count still observable (diagnostics reset does not clear index)
    expect(getScrollSnapshotDiagnostics().indexCount).toBe(diag.indexCount)
    // reset cache clears index as well
    resetScrollSnapshotCacheForTests()
    expect(getScrollSnapshotDiagnostics().indexCount).toBe(0)
  })

  it('B-07: indexCountBefore is raw pre-enforcement count and expiredRemoved counts successes (malformed/duplicate/missing)', () => {
    const now = Date.now()
    // Missing index case: rawBefore 0, after rebuild 0
    resetScrollSnapshotCacheForTests()
    resetScrollSnapshotDiagnosticsForTests()
    store = new Map()
    ;(window as any).keyv = createKeyvMock()
    enforceScrollSnapshotBounds(now)
    let diag = getScrollSnapshotDiagnostics()
    expect(diag.lastEnforcement!.indexCountBefore).toBe(0)
    expect(diag.lastEnforcement!.didRebuild).toBe(true)
    expect(diag.lastEnforcement!.expiredRemoved).toBe(0)

    // Duplicate + malformed raw: raw length includes duplicates/malformed, before should reflect raw
    resetScrollSnapshotCacheForTests()
    resetScrollSnapshotDiagnosticsForTests()
    store = new Map()
    ;(window as any).keyv = createKeyvMock()
    const dupKey = 'scroll:topic-dup-b07'
    store.set(dupKey, { scrollTop: -1, anchorId: null, isAtBottom: false })
    store.set('scroll:topic-other-b07', { scrollTop: -2, anchorId: null, isAtBottom: false })
    const rawWithIssues: unknown[] = [
      { key: dupKey, lastAccess: now },
      { key: dupKey, lastAccess: now - 1000 }, // duplicate
      { key: 'scroll:topic-other-b07', lastAccess: now },
      { key: 'scroll:SearchResults', lastAccess: now }, // non-topic malformed for B-07
      { key: '', lastAccess: now }, // empty
      { lastAccess: now } as unknown, // missing key
      { key: dupKey, lastAccess: NaN } as unknown // NaN malformed
    ]
    store.set('scroll:__index__', rawWithIssues)
    enforceScrollSnapshotBounds(now)
    diag = getScrollSnapshotDiagnostics()
    // Raw before includes all 7 entries, not just valid 2
    expect(diag.lastEnforcement!.indexCountBefore).toBe(7)
    expect(diag.lastEnforcement!.didRebuild).toBe(true) // had malformed
    expect(diag.indexCount).toBe(2) // only 2 valid after canonical
    expect(diag.lastEnforcement!.indexCountAfter).toBe(2)

    // TTL: expiredRemoved counts successful removals; simulate partial failure
    resetScrollSnapshotCacheForTests()
    resetScrollSnapshotDiagnosticsForTests()
    store = new Map()
    // failing mock: first expired removal throws, others succeed
    let removeCalls = 0
    ;(window as any).keyv = {
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => store.set(k, v),
      remove: (k: string) => {
        removeCalls += 1
        if (k === 'scroll:topic-expired-fail-0') throw new Error('mock fail')
        return store.delete(k)
      },
      keys: () => Array.from(store.keys())
    }
    for (let i = 0; i < 3; i++) {
      const k = `scroll:topic-expired-fail-${i}`
      store.set(k, { scrollTop: -i, anchorId: null, isAtBottom: false })
    }
    for (let i = 0; i < 2; i++) {
      const k = `scroll:topic-fresh-ok-${i}`
      store.set(k, { scrollTop: -i, anchorId: null, isAtBottom: false })
    }
    const idxFail = [
      ...[0, 1, 2].map((i) => ({
        key: `scroll:topic-expired-fail-${i}`,
        lastAccess: now - SCROLL_SNAPSHOT_TTL_MS - 1000
      })),
      ...[0, 1].map((i) => ({ key: `scroll:topic-fresh-ok-${i}`, lastAccess: now }))
    ]
    store.set('scroll:__index__', idxFail)
    enforceScrollSnapshotBounds(now)
    diag = getScrollSnapshotDiagnostics()
    expect(diag.lastEnforcement!.indexCountBefore).toBe(5) // raw 5
    // One expired removal failed, so success count is 2 not 3
    expect(diag.lastEnforcement!.expiredRemoved).toBe(2)
    // Failed key still in store (since throw prevented delete)
    expect(store.get('scroll:topic-expired-fail-0')).toBeDefined()
    expect(store.get('scroll:topic-expired-fail-1')).toBeUndefined()
    expect(removeCalls).toBeGreaterThanOrEqual(3)
  })

  it('B-09: retains <=1 topic and reports cache hit/miss under exercised workload', () => {
    // exercise: cache 5 topics then enforce retention for one active
    for (let i = 0; i < 5; i++) {
      const tid = `t${i}`
      const fp = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: tid, blocks: [] }] as any)
      setCachedContextClosureWithFingerprint(tid, makeResp(tid, 'u1'), fp)
    }
    expect(getContextClosureDiagnostics().retainedTopicCount).toBe(5)
    enforceContextClosureRetention('t2')
    let diag: ContextClosureDiagnostics = getContextClosureDiagnostics()
    expect(diag.retainedTopicCount).toBeLessThanOrEqual(1)
    expect(diag.maxRetainedTopics).toBe(1)
    expect(diag.retainedTopicCount).toBe(1)

    // hit/miss workload: valid hit vs miss due to wrong anchor, generation, etc.
    resetContextClosureDiagnosticsForTests()
    const active = 't-active'
    const fpActive = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: active, blocks: [] }] as any)
    setCachedContextClosureWithFingerprint(active, makeResp(active, 'u1'), fpActive)
    enforceContextClosureRetention(active)
    // hit
    expect(getFreshValidatedClosure(active, 'u1', fpActive)).not.toBeNull()
    // miss: wrong anchor
    expect(getFreshValidatedClosure(active, 'u-wrong', fpActive)).toBeNull()
    // miss: missing topic
    expect(getFreshValidatedClosure('t-missing', 'u1', fpActive)).toBeNull()
    // miss: fingerprint mismatch (same-length visible mutation)
    const fpWrong = computeClosureFingerprint([
      { id: 'u1', role: 'user', topicId: active, status: 'pending', blocks: [] }
    ] as any)
    expect(fpWrong).not.toBe(fpActive)
    expect(getFreshValidatedClosure(active, 'u1', fpWrong)).toBeNull()

    diag = getContextClosureDiagnostics()
    expect(diag.hitCount).toBe(1)
    expect(diag.missCount).toBe(3)
    expect(diag.totalAccessCount).toBe(4)
    expect(diag.retainedTopicCount).toBeLessThanOrEqual(1)

    // coherent snapshot reflects hit/miss
    const snap = getPhase4Snapshot(null)
    expect(snap.b09.hitCount).toBe(1)
    expect(snap.b09.missCount).toBe(3)
    expect(snap.b09.retainedTopicCount).toBeLessThanOrEqual(1)

    // reset diagnostics without clearing cache (preserves retention)
    resetContextClosureDiagnosticsForTests()
    expect(getContextClosureDiagnostics().hitCount).toBe(0)
    expect(getContextClosureDiagnostics().missCount).toBe(0)
    expect(getContextClosureDiagnostics().retainedTopicCount).toBe(1)
  })

  it('B-08: never has >500 live ranges and records chunk-rescan/invalidation behavior', async () => {
    const filter = makeFilter()
    const target = document.createElement('div')
    // 650 containers * 2 matches = 1300 total, 3 chunks (500,500,300)
    target.innerHTML = Array.from({ length: 650 })
      .map(() => '<div>hello world hello</div>')
      .join('')
    document.body.appendChild(target)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    const host = screen.getByTestId('content-search-host')
    const input = screen.getByTestId('content-search').querySelector('input') as HTMLInputElement
    input.value = 'hello'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(screen.getByTestId('content-search').textContent).toContain('1/1300'))

    let diag = getContentSearchDiagnostics()
    expect(diag.liveRangeCount).toBeLessThanOrEqual(500)
    expect(diag.liveRangeCount).toBe(500)
    expect(diag.totalCount).toBe(1300)
    expect(diag.chunkSize).toBe(500)
    expect(diag.maxLiveRanges).toBe(500)
    expect(diag.domGeneration).toBeGreaterThanOrEqual(1)
    // check data attributes bounded
    expect(Number(host.getAttribute('data-live-ranges'))).toBeLessThanOrEqual(500)
    // coherent snapshot pattern
    let snap = getPhase4Snapshot(null)
    expect(snap.b08.liveRangeCount).toBeLessThanOrEqual(500)
    expect(snap.b08.totalCount).toBe(1300)

    // cross-chunk navigation: advance to 501 should rescan next chunk
    for (let i = 0; i < 500; i++) {
      await act(async () => {
        ref.current?.searchNext()
      })
    }
    await waitFor(() => expect(screen.getByTestId('content-search').textContent).toContain('501/1300'))
    diag = getContentSearchDiagnostics()
    expect(diag.liveRangeCount).toBeLessThanOrEqual(500)
    expect(diag.chunkIndex).toBe(1)
    expect(diag.rescanCount).toBeGreaterThan(0)
    expect(Number(host.getAttribute('data-live-ranges'))).toBeLessThanOrEqual(500)

    // DOM mutation invalidation: add content and trigger mutation observer invalidation
    // Capture counters BEFORE mutation for strict increment assertion (audit #4)
    const beforeInvalidations = getContentSearchDiagnostics().invalidationCount
    const beforeRescans = getContentSearchDiagnostics().rescanCount
    target.innerHTML += Array.from({ length: 200 })
      .map(() => '<div>hello hello</div>')
      .join('')
    // Allow mutation observer to mark dirty (async microtask)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    // same-chunk next should trigger rescan due to DOM dirty before continuing
    // Navigate within same chunk but with stale DOM -> should rescan
    await act(async () => {
      ref.current?.searchNext()
    })
    // total should have refreshed exactly (1300 + 400 = 1700), not stale 1300
    await waitFor(() => {
      const txt = screen.getByTestId('content-search').textContent || ''
      expect(txt).toContain('/1700')
    })
    diag = getContentSearchDiagnostics()
    // strict invalidation/rescan increments (not >=)
    expect(diag.invalidationCount).toBeGreaterThan(beforeInvalidations)
    expect(diag.rescanCount).toBeGreaterThan(beforeRescans)
    expect(diag.totalCount).toBe(1700)
    expect(diag.liveRangeCount).toBeLessThanOrEqual(500)
    snap = getPhase4Snapshot(null)
    expect(snap.b08.liveRangeCount).toBeLessThanOrEqual(500)
    // verify snapshot contains no message content
    expect(JSON.stringify(snap.b08)).not.toContain('hello')
    expect(JSON.stringify(snap.b08)).not.toContain('world')

    document.body.removeChild(target)
  })

  it('B-08: unmount retires diagnostics and replacement isolation (session-owned)', async () => {
    const filter = makeFilter()
    // First session: 650 containers *2 =1300 matches
    const targetA = document.createElement('div')
    targetA.innerHTML = Array.from({ length: 650 })
      .map(() => '<div>hello world hello</div>')
      .join('')
    document.body.appendChild(targetA)
    const refA = { current: null as any } as React.RefObject<ContentSearchRef>
    const { unmount: unmountA } = render(
      <ContentSearch ref={refA} searchTarget={targetA} filter={filter} onClose={() => {}} />
    )
    const inputA = screen.getAllByTestId('content-search').at(-1)!.querySelector('input') as HTMLInputElement
    inputA.value = 'hello'
    await act(async () => {
      refA.current?.search()
    })
    await waitFor(() => expect(screen.getAllByTestId('content-search').at(-1)!.textContent).toContain('1/1300'))
    let diag = getContentSearchDiagnostics()
    expect(diag.liveRangeCount).toBe(500)
    expect(diag.totalCount).toBe(1300)

    // Unmount owning instance should retire active snapshot (live 0/total 0) without retaining DOM
    unmountA()
    // allow unmount effect to flush
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    diag = getContentSearchDiagnostics()
    expect(diag.liveRangeCount).toBe(0)
    expect(diag.totalCount).toBe(0)
    expect(diag.chunkIndex).toBe(0)
    // counters preserved but live cleared
    expect(JSON.stringify(diag)).not.toContain('hello')

    // Replacement isolation: mount B, verify B owns diagnostics after A unmounted
    const targetB = document.createElement('div')
    targetB.innerHTML = '<div>alpha beta alpha</div>'
    document.body.appendChild(targetB)
    const refB = { current: null as any } as React.RefObject<ContentSearchRef>
    const { unmount: unmountB1 } = render(
      <ContentSearch ref={refB} searchTarget={targetB} filter={filter} onClose={() => {}} />
    )
    const inputB = screen.getAllByTestId('content-search').at(-1)!.querySelector('input') as HTMLInputElement
    inputB.value = 'alpha'
    await act(async () => {
      refB.current?.search()
    })
    await waitFor(() => expect(screen.getAllByTestId('content-search').at(-1)!.textContent).toContain('1/2'))
    diag = getContentSearchDiagnostics()
    expect(diag.liveRangeCount).toBe(2)
    expect(diag.totalCount).toBe(2)

    // Overlapping replacement isolation: mount A2 and ensure stale unmount does not clear active
    const targetA2 = document.createElement('div')
    targetA2.innerHTML = Array.from({ length: 10 })
      .map(() => '<div>hello world hello</div>')
      .join('')
    document.body.appendChild(targetA2)
    const refA2 = { current: null as any } as React.RefObject<ContentSearchRef>
    const { unmount: unmountA2 } = render(
      <ContentSearch ref={refA2} searchTarget={targetA2} filter={filter} onClose={() => {}} />
    )
    const inputA2 = screen.getAllByTestId('content-search').at(-1)!.querySelector('input') as HTMLInputElement
    inputA2.value = 'hello'
    await act(async () => {
      refA2.current?.search()
    })
    await waitFor(() => expect(screen.getAllByTestId('content-search').at(-1)!.textContent).toContain('1/20'))
    // Now A2 owns active snapshot (20 matches)
    diag = getContentSearchDiagnostics()
    expect(diag.totalCount).toBe(20)
    const beforeUnmountActive = diag.totalCount
    // Unmount previous B1 (stale owner) should NOT clear A2's active snapshot
    unmountB1()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    diag = getContentSearchDiagnostics()
    // Still reflects A2 (not cleared)
    expect(diag.liveRangeCount).toBeGreaterThan(0)
    expect(diag.totalCount).toBe(beforeUnmountActive)

    // Cleanup: unmount remaining
    unmountA2()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    diag = getContentSearchDiagnostics()
    expect(diag.liveRangeCount).toBe(0)
    expect(diag.totalCount).toBe(0)

    document.body.removeChild(targetA)
    document.body.removeChild(targetB)
    document.body.removeChild(targetA2)
  })

  it('B-08 ownership: mounted-but-unused B cannot clear A snapshot on unmount', async () => {
    const filter = makeFilter()
    const targetA = document.createElement('div')
    targetA.innerHTML = Array.from({ length: 650 })
      .map(() => '<div>hello world hello</div>')
      .join('')
    document.body.appendChild(targetA)
    const refA = { current: null as any } as React.RefObject<ContentSearchRef>
    const { unmount: unmountA } = render(
      <ContentSearch ref={refA} searchTarget={targetA} filter={filter} onClose={() => {}} />
    )
    const hostA = screen.getAllByTestId('content-search-host').at(-1)!
    const inputA = screen.getAllByTestId('content-search').at(-1)!.querySelector('input') as HTMLInputElement
    inputA.value = 'hello'
    await act(async () => {
      refA.current?.search()
    })
    await waitFor(() => expect(screen.getAllByTestId('content-search').at(-1)!.textContent).toContain('1300'))
    let diag = getContentSearchDiagnostics()
    expect(diag.liveRangeCount).toBe(500)
    expect(diag.totalCount).toBe(1300)
    const ownerA = getActiveContentSearchOwnerForTests()
    expect(ownerA).not.toBeNull()
    const snapshotA = { ...diag }

    // Mount unused B (no search) — must not become active owner nor clear A
    const targetB = document.createElement('div')
    targetB.innerHTML = '<div>alpha beta alpha</div>'
    document.body.appendChild(targetB)
    const refB = { current: null as any } as React.RefObject<ContentSearchRef>
    const { unmount: unmountB } = render(
      <ContentSearch ref={refB} searchTarget={targetB} filter={filter} onClose={() => {}} />
    )
    // Diagnostics must remain A after mounting unused B
    diag = getContentSearchDiagnostics()
    expect(diag.liveRangeCount).toBe(snapshotA.liveRangeCount)
    expect(diag.totalCount).toBe(snapshotA.totalCount)
    expect(diag.chunkIndex).toBe(snapshotA.chunkIndex)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerA)
    // Host of A should still show live ranges 500
    expect(hostA.getAttribute('data-live-ranges')).toBe('500')

    // Unmount unused B — must not clear A's committed snapshot
    unmountB()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    diag = getContentSearchDiagnostics()
    expect(diag.liveRangeCount).toBe(snapshotA.liveRangeCount)
    expect(diag.totalCount).toBe(snapshotA.totalCount)
    expect(diag.chunkIndex).toBe(snapshotA.chunkIndex)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerA)

    // Owning unmount clears only its committed snapshot
    unmountA()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    diag = getContentSearchDiagnostics()
    expect(diag.liveRangeCount).toBe(0)
    expect(diag.totalCount).toBe(0)
    expect(diag.chunkIndex).toBe(0)
    expect(getActiveContentSearchOwnerForTests()).toBeNull()

    document.body.removeChild(targetA)
    document.body.removeChild(targetB)
  })

  it('B-08 ownership: stale A cannot overwrite active B snapshot via search/navigation/diagnostic writes', async () => {
    const filter = makeFilter()
    // A commits first
    const targetA = document.createElement('div')
    targetA.innerHTML = Array.from({ length: 650 })
      .map(() => '<div>hello world hello</div>')
      .join('')
    document.body.appendChild(targetA)
    const refA = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={refA} searchTarget={targetA} filter={filter} onClose={() => {}} />)
    const inputA = screen.getAllByTestId('content-search').at(-1)!.querySelector('input') as HTMLInputElement
    inputA.value = 'hello'
    await act(async () => {
      refA.current?.search()
    })
    await waitFor(() => expect(screen.getAllByTestId('content-search').at(-1)!.textContent).toContain('1300'))
    const diagA = getContentSearchDiagnostics()
    expect(diagA.totalCount).toBe(1300)
    const ownerA = getActiveContentSearchOwnerForTests()!

    // B commits and becomes active
    const targetB = document.createElement('div')
    targetB.innerHTML = '<div>alpha beta alpha</div>'
    document.body.appendChild(targetB)
    const refB = { current: null as any } as React.RefObject<ContentSearchRef>
    const { unmount: unmountB } = render(
      <ContentSearch ref={refB} searchTarget={targetB} filter={filter} onClose={() => {}} />
    )
    const inputB = screen.getAllByTestId('content-search').at(-1)!.querySelector('input') as HTMLInputElement
    inputB.value = 'alpha'
    await act(async () => {
      refB.current?.search()
    })
    await waitFor(() => expect(screen.getAllByTestId('content-search').at(-1)!.textContent).toContain('1/2'))
    let diagB = getContentSearchDiagnostics()
    expect(diagB.liveRangeCount).toBe(2)
    expect(diagB.totalCount).toBe(2)
    const ownerB = getActiveContentSearchOwnerForTests()!
    expect(ownerB).not.toBe(ownerA)

    const snapshotB = { ...diagB }

    // Stale A attempts via component API: search must not overwrite B snapshot
    inputA.value = 'hello'
    await act(async () => {
      refA.current?.search()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    diagB = getContentSearchDiagnostics()
    expect(diagB.liveRangeCount).toBe(snapshotB.liveRangeCount)
    expect(diagB.totalCount).toBe(snapshotB.totalCount)
    expect(diagB.chunkIndex).toBe(snapshotB.chunkIndex)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerB)

    // Stale A navigation must not overwrite
    await act(async () => {
      refA.current?.searchNext()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    diagB = getContentSearchDiagnostics()
    expect(diagB.totalCount).toBe(snapshotB.totalCount)
    expect(diagB.liveRangeCount).toBe(snapshotB.liveRangeCount)

    // Stale A direct diagnostic writes must be ignored (owner-aware guard)
    const beforeDirect = { ...getContentSearchDiagnostics() }
    recordContentSearchCommit(ownerA, 999, 9, 9999, 999)
    expect(getContentSearchDiagnostics().totalCount).toBe(beforeDirect.totalCount)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(beforeDirect.liveRangeCount)
    expect(getContentSearchDiagnostics().chunkIndex).toBe(beforeDirect.chunkIndex)
    recordContentSearchClear(ownerA, 1000)
    expect(getContentSearchDiagnostics().totalCount).toBe(beforeDirect.totalCount)
    recordContentSearchInvalidation(ownerA, 1001)
    // invalidationCount should not have advanced for stale owner
    const invalidationBefore = beforeDirect.invalidationCount
    expect(getContentSearchDiagnostics().invalidationCount).toBe(invalidationBefore)
    recordContentSearchRescanIncrement(ownerA)
    expect(getContentSearchDiagnostics().rescanCount).toBe(beforeDirect.rescanCount)

    // Stale A unmount must not clear B snapshot
    // Unmount via release check directly to simulate stale instance unmount
    const staleReleaseResult = releaseContentSearchSessionIfOwned(ownerA)
    expect(staleReleaseResult).toBe(false)
    diagB = getContentSearchDiagnostics()
    expect(diagB.totalCount).toBe(snapshotB.totalCount)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerB)

    // Owning B unmount clears only its committed snapshot
    const owningRelease = releaseContentSearchSessionIfOwned(ownerB)
    expect(owningRelease).toBe(true)
    diagB = getContentSearchDiagnostics()
    expect(diagB.liveRangeCount).toBe(0)
    expect(diagB.totalCount).toBe(0)
    expect(getActiveContentSearchOwnerForTests()).toBeNull()

    // B already released; render's unmount should be no-op (already cleared)
    unmountB()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(0)

    document.body.removeChild(targetA)
    document.body.removeChild(targetB)
  })

  it('B-08 ownership: direct API respects committed ownership and privacy (no DOM/Range/content retained)', () => {
    const ownerA = createContentSearchSessionOwnerId()
    const ownerB = createContentSearchSessionOwnerId()
    const ownerC = createContentSearchSessionOwnerId()
    // No owner yet; first commit claims
    recordContentSearchCommit(ownerA, 10, 0, 10, 1)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerA)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(10)
    expect(getContentSearchDiagnostics().totalCount).toBe(10)
    // Fresh B steals ownership on first committed snapshot (replacement)
    recordContentSearchCommit(ownerB, 99, 5, 999, 2)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(99)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerB)
    expect(getContentSearchDiagnostics().totalCount).toBe(999)
    // Now A is stale (previously active) — cannot overwrite current active B
    recordContentSearchCommit(ownerA, 5, 1, 10, 2)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(99)
    expect(getContentSearchDiagnostics().chunkIndex).toBe(5)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerB)
    // Active owner B can update
    recordContentSearchCommit(ownerB, 5, 1, 999, 2)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(5)
    expect(getContentSearchDiagnostics().chunkIndex).toBe(1)
    // Fresh C (never committed) can steal, stale A still cannot
    recordContentSearchCommit(ownerC, 7, 0, 7, 3)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerC)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(7)
    recordContentSearchCommit(ownerA, 8, 0, 8, 4)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(7)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerC)
    // Reset to test clear/invalidation path with known owners — use fresh owners to avoid cross-contamination
    resetContentSearchDiagnosticsForTests()
    const ownerA2 = createContentSearchSessionOwnerId()
    const ownerB2 = createContentSearchSessionOwnerId()
    recordContentSearchCommit(ownerA2, 10, 0, 10, 1)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerA2)
    // Establish live 10, then make B2 fresh steal to create stale scenario for clear test
    recordContentSearchCommit(ownerB2, 5, 0, 5, 2)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerB2)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(5)
    // Stale clear ignored (ownerA2 now stale, cannot clear B2's active snapshot)
    recordContentSearchClear(ownerA2, 3)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(5)
    // Active clear claims and resets live but preserves counters
    const beforeInvalid = getContentSearchDiagnostics().invalidationCount
    recordContentSearchClear(ownerB2, 3)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(0)
    expect(getContentSearchDiagnostics().totalCount).toBe(0)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerB2)
    // Invalidation only from active owner
    recordContentSearchInvalidation(ownerA2, 4)
    expect(getContentSearchDiagnostics().invalidationCount).toBe(beforeInvalid)
    recordContentSearchInvalidation(ownerB2, 4)
    expect(getContentSearchDiagnostics().invalidationCount).toBe(beforeInvalid + 1)
    // Stale invalidation does not change domGeneration
    const genBefore = getContentSearchDiagnostics().domGeneration
    recordContentSearchInvalidation(ownerA2, 999)
    expect(getContentSearchDiagnostics().domGeneration).toBe(genBefore)
    // Release stale does not clear
    expect(releaseContentSearchSessionIfOwned(ownerA2)).toBe(false)
    expect(getContentSearchDiagnostics().domGeneration).toBe(genBefore)
    // Release active clears live snapshot and relinquishes ownership
    expect(releaseContentSearchSessionIfOwned(ownerB2)).toBe(true)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(0)
    expect(getActiveContentSearchOwnerForTests()).toBeNull()
    // Now fresh owner can claim after release
    const ownerFresh = createContentSearchSessionOwnerId()
    recordContentSearchCommit(ownerFresh, 7, 0, 7, 5)
    expect(getActiveContentSearchOwnerForTests()).toBe(ownerFresh)
    expect(getContentSearchDiagnostics().liveRangeCount).toBe(7)
    // Privacy: diagnostics contain only scalars, no DOM/Range/content
    const serialized = JSON.stringify(getContentSearchDiagnostics())
    expect(serialized).not.toContain('hello')
    // liveRangeCount key contains substring Range but diagnostics must not retain actual Range objects or DOM content
    expect(serialized).not.toContain('<div')
    // Shape preserved: scalar keys only
    const diag = getContentSearchDiagnostics()
    expect(Object.keys(diag).sort()).toEqual(
      [
        'chunkIndex',
        'chunkSize',
        'domGeneration',
        'invalidationCount',
        'liveRangeCount',
        'maxLiveRanges',
        'rescanCount',
        'totalCount'
      ].sort()
    )
    // Cleanup
    releaseContentSearchSessionIfOwned(ownerFresh)
  })

  it('coherent common diagnostic assertion pattern: all bounds simultaneously via getPhase4Snapshot', async () => {
    // B-06 window pressure
    const msgs = users(400)
    let win = createLatestMessageWindow(msgs, 200)
    win = expandMessageWindowOlder(msgs, win, 50)
    // B-07 pressure (150 topics)
    const now = Date.now()
    for (let i = 0; i < 150; i++) {
      const k = `scroll:topic-coherent-${i}`
      store.set(k, { scrollTop: -i, anchorId: null, isAtBottom: false })
      handleScrollSnapshotSaved(k, now + i)
    }
    // B-09 pressure (retain 1, hit/miss)
    resetContextClosureDiagnosticsForTests()
    const fp = computeClosureFingerprint([{ id: 'u1', role: 'user', topicId: 't-coherent', blocks: [] }] as any)
    setCachedContextClosureWithFingerprint('t-coherent', makeResp('t-coherent', 'u1'), fp)
    enforceContextClosureRetention('t-coherent')
    getFreshValidatedClosure('t-coherent', 'u1', fp) // hit
    getFreshValidatedClosure('t-coherent', 'wrong', fp) // miss
    // B-08 pressure minimal (search with small DOM)
    const filter = makeFilter()
    const target = document.createElement('div')
    target.innerHTML = '<div>alpha beta alpha</div>'
    document.body.appendChild(target)
    const ref = { current: null as any } as React.RefObject<ContentSearchRef>
    render(<ContentSearch ref={ref} searchTarget={target} filter={filter} onClose={() => {}} />)
    const input = screen.getByTestId('content-search').querySelector('input') as HTMLInputElement
    input.value = 'alpha'
    await act(async () => {
      ref.current?.search()
    })
    await waitFor(() => expect(screen.getByTestId('content-search').textContent).toContain('1/2'))

    const snap = getPhase4Snapshot(win)
    // Common assertion pattern: all bounds never exceed implemented limits
    expect(snap.b06).not.toBeNull()
    expect(snap.b06!.groupCount).toBeLessThanOrEqual(200)
    expect(snap.b06!.calibrationDefault).toBe(200)
    expect(snap.b07.indexCount).toBeLessThanOrEqual(256)
    expect(snap.b07.maxCount).toBe(256)
    expect(snap.b08.liveRangeCount).toBeLessThanOrEqual(500)
    expect(snap.b08.maxLiveRanges).toBe(500)
    expect(snap.b09.retainedTopicCount).toBeLessThanOrEqual(1)
    expect(snap.b09.maxRetainedTopics).toBe(1)
    expect(snap.b09.hitCount).toBeGreaterThanOrEqual(1)
    expect(snap.b09.missCount).toBeGreaterThanOrEqual(1)
    // No message content in snapshot
    const serialized = JSON.stringify(snap)
    expect(serialized).not.toContain('alpha')
    expect(serialized).not.toContain('beta')
    // Scalar-only check: ensure snapshot keys are expected bounded scalars, not paths/credentials/sizes
    expect(serialized).not.toContain('path')
    expect(serialized).not.toContain('credential')
    expect(serialized).not.toContain('database')

    document.body.removeChild(target)
  })
})
