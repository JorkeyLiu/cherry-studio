/**
 * Route-restore preferred visual anchor + pagination compensation behavior.
 *
 * Covers the visual-model fix contract without DOM:
 * - anchor creation/binding (divider-row + message-row, topic/route/epoch);
 * - queue-time snapshot copies stable identity + targetOffset (never the ref);
 * - replay retains the snapshot; route change discards via the existing guard;
 * - pagination compensation prefers the anchor offset, falls back only when
 *   the target is missing/disconnected, and ordinary pagination is unchanged;
 * - pagination never starts a second stabilizer while a restore stabilizer is
 *   active.
 */
import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { createPendingOlderIntent, decidePendingOlderReplay } from '../messagePaginationIntent'
import { createMessageViewportState } from '../messageViewportReducer'
import {
  createDividerRestoreAnchor,
  createMessageRestoreAnchor,
  decidePaginationCompensation,
  isActiveRestoreAnchorCurrent,
  shouldStartPaginationStabilizer,
  snapshotRestoreAnchor
} from '../routeRestoreAnchor'

const live = { topicId: 't1', routeId: 'b1' as string | null, restoreEpoch: 9 }

describe('preferred restore anchor lifecycle', () => {
  it('binds divider-row and message-row anchors to topic/route/epoch', () => {
    const divider = createDividerRestoreAnchor({
      dividerKey: 'm15::main',
      targetOffset: 120,
      topicId: 't1',
      routeId: 'b1',
      restoreEpoch: 9
    })
    const saved = createMessageRestoreAnchor({
      messageId: 'm7',
      targetOffset: 34,
      topicId: 't1',
      routeId: 'b1',
      restoreEpoch: 9
    })
    expect(isActiveRestoreAnchorCurrent(divider, live)).toBe(true)
    expect(isActiveRestoreAnchorCurrent(saved, live)).toBe(true)
    expect(isActiveRestoreAnchorCurrent(divider, { ...live, routeId: 'b2' })).toBe(false)
    expect(isActiveRestoreAnchorCurrent(divider, { ...live, topicId: 't2' })).toBe(false)
    expect(isActiveRestoreAnchorCurrent(divider, { ...live, restoreEpoch: 10 })).toBe(false)
    expect(isActiveRestoreAnchorCurrent(null, live)).toBe(false)
  })

  it('top-selector saved rows snapshot their intra-row offset', () => {
    const saved = createMessageRestoreAnchor({
      messageId: 'm7',
      targetOffset: 34,
      topicId: 't1',
      routeId: 'b1',
      restoreEpoch: 9
    })
    expect(snapshotRestoreAnchor(saved, live)).toEqual({ kind: 'message-row', messageId: 'm7', targetOffset: 34 })
  })
})

describe('pending intent carries a detached snapshot', () => {
  it('copies divider and message anchors by value, never by ref', () => {
    const divider = createDividerRestoreAnchor({
      dividerKey: 'm15::main',
      targetOffset: 120,
      topicId: 't1',
      routeId: 'b1',
      restoreEpoch: 9
    })
    const snap = snapshotRestoreAnchor(divider, live)!
    const intent = createPendingOlderIntent({
      topicId: 't1',
      routeId: 'b1',
      topicGeneration: 3,
      deletionGeneration: 0,
      residentGeneration: 7,
      preferredAnchor: snap
    })
    expect(intent.preferredAnchor).toEqual({ kind: 'divider-row', dividerKey: 'm15::main', targetOffset: 120 })
    // Mutating the snapshot source afterwards cannot move the queued copy.
    snap.targetOffset = 999
    expect(intent.preferredAnchor).toEqual({ kind: 'divider-row', dividerKey: 'm15::main', targetOffset: 120 })

    const saved = createMessageRestoreAnchor({
      messageId: 'm7',
      targetOffset: 34,
      topicId: 't1',
      routeId: 'b1',
      restoreEpoch: 9
    })
    const savedIntent = createPendingOlderIntent({
      topicId: 't1',
      routeId: 'b1',
      topicGeneration: 3,
      deletionGeneration: 0,
      residentGeneration: 7,
      preferredAnchor: snapshotRestoreAnchor(saved, live)
    })
    expect(savedIntent.preferredAnchor).toEqual({ kind: 'message-row', messageId: 'm7', targetOffset: 34 })
  })

  it('ordinary pagination snapshots null (behavior unchanged)', () => {
    const intent = createPendingOlderIntent({
      topicId: 't1',
      routeId: 'b1',
      topicGeneration: 3,
      deletionGeneration: 0,
      residentGeneration: 7
    })
    expect(intent.preferredAnchor).toBeNull()
    expect(snapshotRestoreAnchor(null, live)).toBeNull()
    expect(snapshotRestoreAnchor(undefined, live)).toBeNull()
  })

  it('replay retains the snapshot; the existing five-tuple guard still discards cross-generation use', () => {
    const pending = createPendingOlderIntent({
      topicId: 't1',
      routeId: 'b1',
      topicGeneration: 3,
      deletionGeneration: 0,
      residentGeneration: 7,
      preferredAnchor: { kind: 'divider-row', dividerKey: 'm15::main', targetOffset: 120 }
    })
    const idle = createMessageViewportState().navigation
    const baseLive = {
      topicId: 't1',
      routeId: 'b1' as string | null,
      topicGeneration: 3,
      deletionGeneration: 0,
      residentGeneration: 7,
      hasMoreOlder: true,
      loadingOlder: false
    }
    const committed = { navigation: idle, scrollMode: 'user' as const, topicGeneration: 3 }
    expect(decidePendingOlderReplay({ pending, live: baseLive, committed, atOldestEdge: true })).toEqual({
      action: 'replay'
    })
    // The snapshot travels with the replay call (caller passes
    // pending.preferredAnchor into startOlderWindowLoad); the decision itself
    // stays generation-bound.
    expect(pending.preferredAnchor).toEqual({ kind: 'divider-row', dividerKey: 'm15::main', targetOffset: 120 })
    // Route change discards — the snapshot never crosses generations.
    expect(
      decidePendingOlderReplay({
        pending,
        live: { ...baseLive, routeId: 'b2' },
        committed,
        atOldestEdge: true
      })
    ).toEqual({ action: 'discard', reason: 'route' })
  })
})

describe('pagination compensation prefers the restore anchor', () => {
  it('computes the preferred delta from the current element offset', () => {
    // Divider pushed 867px by inserted older rows: compensate back to target.
    expect(
      decidePaginationCompensation({
        preferred: { kind: 'divider-row', dividerKey: 'm15::main', targetOffset: 120 },
        preferredCurrentOffset: 987,
        fallbackDelta: 5
      })
    ).toEqual({ kind: 'preferred', delta: 867 })
    expect(
      decidePaginationCompensation({
        preferred: { kind: 'message-row', messageId: 'm7', targetOffset: 34 },
        preferredCurrentOffset: 40,
        fallbackDelta: 200
      })
    ).toEqual({ kind: 'preferred', delta: 6 })
  })

  it('falls back to the viewport-top message only when the target is missing/disconnected', () => {
    expect(
      decidePaginationCompensation({
        preferred: { kind: 'divider-row', dividerKey: 'm15::main', targetOffset: 120 },
        preferredCurrentOffset: null,
        fallbackDelta: 42
      })
    ).toEqual({ kind: 'fallback', delta: 42 })
    expect(
      decidePaginationCompensation({
        preferred: { kind: 'divider-row', dividerKey: 'm15::main', targetOffset: 120 },
        preferredCurrentOffset: null,
        fallbackDelta: null
      })
    ).toEqual({ kind: 'none' })
  })

  it('ordinary pagination without a preferred anchor keeps the old fallback path', () => {
    expect(decidePaginationCompensation({ preferred: null, preferredCurrentOffset: null, fallbackDelta: 17 })).toEqual({
      kind: 'fallback',
      delta: 17
    })
    expect(decidePaginationCompensation({ preferred: null, preferredCurrentOffset: null, fallbackDelta: 0.5 })).toEqual(
      { kind: 'none' }
    )
  })

  it('never starts a second stabilizer while the restore stabilizer is active', () => {
    expect(shouldStartPaginationStabilizer({ hasActiveRestoreStabilizer: true, usedPreferredAnchor: true })).toBe(false)
    expect(shouldStartPaginationStabilizer({ hasActiveRestoreStabilizer: false, usedPreferredAnchor: true })).toBe(true)
    expect(shouldStartPaginationStabilizer({ hasActiveRestoreStabilizer: false, usedPreferredAnchor: false })).toBe(
      false
    )
  })
})

describe('pagination beginScroll race (live re-read, no second stabilizer)', () => {
  it('maps live ref presence to the stabilizer guard input (contended -> never start)', () => {
    // beginScroll wait期间 active 出现 => live 非空 => hasActive true => 不启动.
    const contendedLive = { current: { handle: {}, epoch: 9 } } as unknown as { current: object | null }
    expect(
      shouldStartPaginationStabilizer({
        hasActiveRestoreStabilizer: contendedLive.current !== null,
        usedPreferredAnchor: true
      })
    ).toBe(false)
    // live 仍空 + preferred => 启动短 stabilizer.
    const emptyLive = { current: null } as unknown as { current: object | null }
    expect(
      shouldStartPaginationStabilizer({
        hasActiveRestoreStabilizer: emptyLive.current !== null,
        usedPreferredAnchor: true
      })
    ).toBe(true)
    // 空但非 preferred (fallback) => 仍不启动.
    expect(
      shouldStartPaginationStabilizer({
        hasActiveRestoreStabilizer: emptyLive.current !== null,
        usedPreferredAnchor: false
      })
    ).toBe(false)
  })

  it('re-reads live active immediately after beginScroll success and never hardcodes the guard', () => {
    const code = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
    // No hardcoded false — the guard always receives live state.
    expect(code).not.toMatch(/hasActiveRestoreStabilizer:\s*false/)
    expect(code).toMatch(/hasActiveRestoreStabilizer:\s*hasActivePaginationBlocker/)
    const beginIdx = code.indexOf("await beginScroll('anchoring', scrollToken)")
    expect(beginIdx).toBeGreaterThan(-1)
    const rereadIdx = code.indexOf('activeAfterBegin = activeStabilizerRef.current', beginIdx)
    expect(rereadIdx).toBeGreaterThan(beginIdx)
    const guardIdx = code.indexOf('shouldStartPaginationStabilizer', rereadIdx)
    expect(guardIdx).toBeGreaterThan(rereadIdx)
  })

  it('contended branch does single delta + suppress, ends its own token, and never assigns/clears the other ref', () => {
    const code = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
    const rereadIdx = code.indexOf('activeAfterBegin = activeStabilizerRef.current')
    expect(rereadIdx).toBeGreaterThan(-1)
    // Bound the contended branch: from re-read to the first guarded stabilizer start.
    const guardIdx = code.indexOf('shouldStartPaginationStabilizer', rereadIdx)
    const branch = code.slice(rereadIdx, guardIdx)
    expect(branch).toMatch(/if \(activeAfterBegin\)/)
    expect(branch).toMatch(/live\.scrollTop \+= delta/)
    expect(branch).toMatch(/armStabilizerSuppress/)
    expect(branch).toMatch(/viewportDispatch\(\{ type: 'scroll\/end', token: scrollToken \}\)/)
    // Contended path returns early and never claims the shared ref.
    expect(branch).not.toMatch(/activeStabilizerRef\.current = \{ handle: stabilizer/)
    expect(branch).not.toMatch(/runBoundedPositionStabilizer/)
  })

  it('pagination stabilizer starts only while live ref is still empty and teardowns only its own handle', () => {
    const code = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
    expect(code).toMatch(/hasActivePaginationBlocker = activeStabilizerRef\.current !== null/)
    expect(code).toMatch(/!hasActivePaginationBlocker/)
    // Handle-identity guard so a same-epoch concurrent session is never cleared.
    expect(code).toMatch(/activeStabilizerRef\.current\?\.handle === stabilizer/)
  })
})

describe('production wiring (behavior-adjacent guards)', () => {
  const src = (): string => fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')

  it('queues the anchor snapshot and replays it into startOlderWindowLoad', () => {
    const code = src()
    expect(code).toMatch(/activeRestoreAnchorRef/)
    expect(code).toMatch(/snapshotRestoreAnchor/)
    expect(code).toMatch(/preferredAnchor/)
    expect(code).toMatch(/startOlderWindowLoad\(replayAnchor\)/)
    expect(code).toMatch(/decidePaginationCompensation/)
    expect(code).toMatch(/shouldStartPaginationStabilizer/)
  })

  it('clears the active anchor on route/topic/deletion/unmount/cancel', () => {
    const code = src()
    // cancelActiveLoads + deletion invalidate + topic-transition timers +
    // unmount teardown + user-cancel + restore completion all clear.
    const hits = code.match(/activeRestoreAnchorRef\.current = null/g) ?? []
    expect(hits.length).toBeGreaterThanOrEqual(6)
  })
})
