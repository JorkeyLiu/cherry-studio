/**
 * Pagination-compensation anchor behavior (pure helper, no transition truth).
 *
 * Covers without DOM:
 * - queued intents carry a detached preferred snapshot (stable identity +
 *   targetOffset, never a live ref); route change discards via the existing
 *   guard;
 * - compensation prefers the anchor offset, falls back only when the target
 *   is missing/disconnected, and ordinary pagination is unchanged.
 *
 * Route-transition truth (epoch/intent/phase/displayed/rendered/anchor)
 * lives SOLELY in `RouteViewportController` — this module owns no lifecycle.
 */
import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { createPendingOlderIntent, decidePendingOlderReplay } from '../messagePaginationIntent'
import { createMessageViewportState } from '../messageViewportReducer'
import { decidePaginationCompensation } from '../routeRestoreAnchor'

describe('pending intent carries a detached snapshot', () => {
  it('copies divider and message anchors by value, never by ref', () => {
    const snap = { kind: 'divider-row', dividerKey: 'm15::main', targetOffset: 120 } as const
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
    ;(snap as { targetOffset: number }).targetOffset = 999
    expect(intent.preferredAnchor).toEqual({ kind: 'divider-row', dividerKey: 'm15::main', targetOffset: 120 })

    const savedIntent = createPendingOlderIntent({
      topicId: 't1',
      routeId: 'b1',
      topicGeneration: 3,
      deletionGeneration: 0,
      residentGeneration: 7,
      preferredAnchor: { kind: 'message-row', messageId: 'm7', targetOffset: 34 }
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
})

describe('pagination compensation (single session, no second stabilizer)', () => {
  it('restore-owned pages apply a direct delta under the search session (never a competing token)', () => {
    const code = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
    // Restore-owned pagination (divider search active for this load): the
    // search owns the token/lifecycle — direct delta, no beginScroll, no
    // stabilizer start. Epoch truth is the controller's session.
    expect(code).toMatch(/owningSearch\.ownerEpoch/)
    expect(code).toMatch(/controller\.isSessionCurrent\(owningSearch\.ownerEpoch\)/)
    expect(code).not.toMatch(/runBoundedPositionStabilizer/)
  })

  it('a transition in flight owns compensation: ordinary pagination never starts a competing token', () => {
    const code = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
    const ownedIdx = code.indexOf('A route transition in flight owns compensation')
    expect(ownedIdx).toBeGreaterThan(-1)
    // Bound to the owned branch only (up to the ordinary path's own token).
    const endIdx = code.indexOf('const scrollToken = {}', ownedIdx)
    expect(endIdx).toBeGreaterThan(ownedIdx)
    const branch = code.slice(ownedIdx, endIdx)
    expect(branch).toMatch(/controller\.programmaticOwned/)
    expect(branch).toMatch(/live\.scrollTop \+= delta/)
    expect(branch).not.toMatch(/beginScroll/)
  })

  it('ordinary pagination compensates once under its own token, then ends it (keeper holds afterwards)', () => {
    const code = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
    expect(code).toMatch(/await beginScroll\('anchoring', scrollToken\)/)
    expect(code).toMatch(/Single compensation only/)
    expect(code).not.toMatch(/activeStabilizerRef/)
    expect(code).not.toMatch(/armStabilizerSuppress/)
  })
})

describe('production wiring (behavior-adjacent guards)', () => {
  const src = (): string => fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')

  it('queues the controller anchor snapshot and replays it into startOlderWindowLoad', () => {
    const code = src()
    expect(code).toMatch(/snapshotPreferredAnchor/)
    expect(code).toMatch(/controller\.getAnchorFor/)
    expect(code).toMatch(/preferredAnchor/)
    expect(code).toMatch(/startOlderWindowLoad\(replayAnchor\)/)
    expect(code).toMatch(/decidePaginationCompensation/)
    expect(code).not.toMatch(/activeRestoreAnchorRef/)
  })

  it('anchor lifecycle is the controller session (invalidate on deletion/unmount/cancel, release on commit/terminate/takeover)', () => {
    const code = src()
    // No scattered anchor null-assignments: one owner, epoch-gated.
    expect(code).not.toMatch(/activeRestoreAnchorRef\.current = null/)
    expect(code).toMatch(/controller\.invalidateAll\(\)/)
    expect(code).toMatch(/controller\.declareUserIntent\(\)/)
    expect(code).toMatch(/controller\.userTakeover\(/)
    expect(code).toMatch(/dividerProgressRef\.current = null/)
  })
})
