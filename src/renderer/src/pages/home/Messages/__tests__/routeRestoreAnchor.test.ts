/**
 * Pagination-compensation anchor behavior (pure helper, no transition truth).
 *
 * Covers without DOM:
 * - compensation prefers the anchor offset, falls back only when the target
 *   is missing/disconnected, and ordinary pagination is unchanged.
 *
 * Route-transition truth (epoch/intent/phase/displayed/rendered/anchor)
 * lives SOLELY in `RouteViewportController` — this module owns no lifecycle.
 */
import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { decidePaginationCompensation } from '../routeRestoreAnchor'

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

describe('pagination compensation (single keeper owner, no second writer)', () => {
  it('restore-owned pages apply a direct delta under the search session (never the keeper path)', () => {
    const code = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
    // Restore-owned pagination (divider search active for this load): the
    // search owns the lifecycle — direct delta, no keeper publish, no
    // stabilizer start. Epoch truth is the controller's session.
    expect(code).toMatch(/owningSearch\.ownerEpoch/)
    expect(code).toMatch(/controller\.isSessionCurrent\(owningSearch\.ownerEpoch\)/)
    expect(code).not.toMatch(/runBoundedPositionStabilizer/)
  })

  it('a transition in flight owns compensation: ordinary pagination never writes over it', () => {
    const code = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
    const ownedIdx = code.indexOf('A route transition in flight owns compensation')
    expect(ownedIdx).toBeGreaterThan(-1)
    const branch = code.slice(ownedIdx, ownedIdx + 2200)
    expect(branch).toMatch(/controller\.programmaticOwned/)
    expect(branch).toMatch(/live\.scrollTop \+= decision\.delta/)
    expect(branch).not.toMatch(/beginScroll/)
    expect(branch).not.toMatch(/adoptOrdinaryPaginationWindow/)
  })

  it('ordinary older pagination publishes the precommit identity to the keeper (no rAF writer, no token)', () => {
    const code = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
    // Single owner: the precommit identity + offset is captured BEFORE the
    // merge dispatch and published through the existing same-route API, so
    // the keeper holds it prepaint. No second scroll writer beside it.
    expect(code).toMatch(/adoptOrdinaryPaginationWindow/)
    expect(code).toMatch(/Precommit capture/)
    expect(code).toMatch(/findViewportTopAnchorWithOffset/)
    expect(code).not.toMatch(/const commitScrollToken = \{\}/)
    expect(code).not.toMatch(/Re-resolve the SAME precommit identity/)
    expect(code).not.toMatch(/activeStabilizerRef/)
    expect(code).not.toMatch(/armStabilizerSuppress/)
    expect(code).not.toMatch(/runBoundedPositionStabilizer/)
    expect(code).not.toMatch(/decideOrdinaryCompensationGate/)
    expect(code).not.toMatch(/isPaginationAnchorStale/)
    expect(code).not.toMatch(/PAGINATION_VIEWPORT_MOVE_PX/)
  })
})

describe('production wiring (behavior-adjacent guards)', () => {
  const src = (): string => fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')

  it('older paging is app-owned: edge trigger from live geometry, no external latch or replay', () => {
    const code = src()
    expect(code).toMatch(/maybeLoadOlderAtEdge/)
    expect(code).toMatch(/isColumnReverseAtOldest/)
    expect(code).toMatch(/hasActiveUserInteraction/)
    expect(code).toMatch(/data-older-paging="app-owned"/)
    expect(code).not.toMatch(/react-infinite-scroll-component/)
    expect(code).not.toMatch(/messagePaginationIntent/)
    expect(code).not.toMatch(/pendingOlderIntentRef/)
    expect(code).not.toMatch(/decidePendingOlderReplay/)
    expect(code).not.toMatch(/shouldQueueOlderIntent/)
    expect(code).not.toMatch(/totalInteractionDeclares/)
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
