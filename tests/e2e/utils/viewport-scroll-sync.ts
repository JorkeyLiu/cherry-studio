import type { Page } from '@playwright/test'

/**
 * Shared scroll/anchor stabilization for viewport E2E (test-side only, no
 * production semantics).
 *
 * Why this exists: the previous spec-local `wheel` helpers used a fixed
 * 220ms post-wheel sleep plus a 140ms poll loop that passed after two
 * unchanged geometry frames. Two unchanged frames never prove the wheel was
 * delivered, and a fixed sleep is completion-by-timer. This module replaces
 * both with state-driven stabilization:
 * - a real user wheel is still dispatched (representative behavior kept);
 * - success requires OBSERVED scroll movement (scrollTop delta) or a
 *   deterministic boundary no-op (no movement + provably at a scroll
 *   extreme), plus a consecutive stable run of anchor id/offset, scroll
 *   geometry, controller phase, and persisted-snapshot agreement;
 * - a stale geometry that moves again resets the run — it can never pass
 *   early on two old frames;
 * - timeouts throw loudly with the last observed state.
 *
 * No in-page event listeners are registered: scroll delivery is proven via
 * atomic cross-context state reads (scrollTop deltas), so there is no
 * listener lifecycle to leak. Sampling is frame-paced through the injected
 * `sleep`.
 */

export interface ScrollGeometry {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** Controller phase (`data-viewport-phase`), '' when the container is missing. */
  phase: string
  anchorId: string
  anchorOffset: number
  /** Persisted snapshot id for the active scroll key ('' when absent/unparsable). */
  snapshotId: string
}

export interface SettleResult {
  id: string
  offset: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  phase: string
  snapshotId: string
  /** True when at least one real scroll movement was observed. */
  scrollSeen: boolean
  /** True when the wheel provably changed nothing at a scroll extreme. */
  boundaryNoOp: boolean
  samples: number
  elapsedMs: number
}

export interface SettleOptions {
  /** Overall budget. Default 10000 (matches the previous 10s settle loops). */
  timeoutMs?: number
  /** Sampling granularity. Default 50. This is sampling pace, never completion proof. */
  sampleMs?: number
  /** Consecutive fully-stable samples required. Default 3 (strictly more than the old blind two-frame pass). */
  stableFrames?: number
  /** Anchor offset tolerance in px. Default 2 (matches the previous ±2). */
  offsetTol?: number
  /** scrollTop movement/stability tolerance in px. Default 2. */
  scrollTol?: number
  /** Scroll-extreme tolerance in px for boundary no-op detection. Default 2. */
  boundaryTol?: number
  /** Quiet period after wheel dispatch before a no-scroll sample may count toward a boundary no-op. Default 250. */
  noScrollGraceMs?: number
  /**
   * Allowed snapshot/anchor ids (provenance gate, same predicate as the
   * specs' `waitSnapMatchesLive`: live anchor must equal the persisted
   * snapshot id and the id must be allowed). Null/undefined disables the
   * snapshot gate (geometry + phase only).
   */
  allowedIds?: string[] | null
}

export interface ScrollSyncDeps {
  read: () => Promise<ScrollGeometry>
  dispatchWheel: (dy: number) => Promise<void>
  sleep: (ms: number) => Promise<void>
  now?: () => number
}

const DEFAULTS = {
  timeoutMs: 10000,
  sampleMs: 50,
  stableFrames: 3,
  offsetTol: 2,
  scrollTol: 2,
  boundaryTol: 2,
  noScrollGraceMs: 250
} as const

/** Controller phases that admit a stable viewport. Mirrors the specs' `waitViewportVisible`. */
export function isPhaseOk(phase: string): boolean {
  return phase === 'revealed' || phase === 'idle'
}

/** True when the container sits at a scroll extreme (either end). */
export function isAtBoundary(
  g: Pick<ScrollGeometry, 'scrollTop' | 'scrollHeight' | 'clientHeight'>,
  tol: number
): boolean {
  if (!Number.isFinite(g.scrollTop) || !Number.isFinite(g.scrollHeight) || !Number.isFinite(g.clientHeight))
    return false
  if (Math.abs(g.scrollTop) <= tol) return true
  const extreme = -(g.scrollHeight - g.clientHeight)
  return Math.abs(g.scrollTop - extreme) <= tol
}

/** Live anchor agrees with the persisted snapshot under the allowed set. An id alone never proves offset — callers keep their offset assertions. */
export function snapshotAgrees(
  g: Pick<ScrollGeometry, 'anchorId' | 'snapshotId'>,
  allowedIds: string[] | null | undefined
): boolean {
  if (allowedIds == null) return true
  if (!g.anchorId || !g.snapshotId) return false
  return g.snapshotId === g.anchorId && allowedIds.includes(g.snapshotId)
}

function describeSample(g: ScrollGeometry | null): string {
  if (!g) return 'null'
  return `${g.anchorId || '(no-anchor)'}@${Math.round(g.anchorOffset * 10) / 10} st=${g.scrollTop} sh=${g.scrollHeight} ch=${g.clientHeight} phase=${g.phase || '(none)'} snap=${g.snapshotId || '(none)'}`
}

function frameStable(
  prev: ScrollGeometry,
  cur: ScrollGeometry,
  o: Required<Omit<SettleOptions, 'allowedIds'>>
): boolean {
  return (
    prev.anchorId !== '' &&
    cur.anchorId === prev.anchorId &&
    Math.abs(cur.anchorOffset - prev.anchorOffset) <= o.offsetTol &&
    Math.abs(cur.scrollTop - prev.scrollTop) <= o.scrollTol &&
    cur.scrollHeight === prev.scrollHeight &&
    cur.clientHeight === prev.clientHeight &&
    isPhaseOk(cur.phase)
  )
}

/**
 * Core stabilization loop. With `wheelDy === null` no wheel is dispatched
 * (post-navigation stabilization: geometry + phase + snapshot only, no
 * delivery proof required). Otherwise success additionally requires observed
 * scroll movement or a deterministic boundary no-op.
 */
export async function settleLoop(
  deps: ScrollSyncDeps,
  options: SettleOptions,
  wheelDy: number | null
): Promise<SettleResult> {
  const o = { ...DEFAULTS, ...options }
  const now = deps.now ?? Date.now
  const t0 = now()
  const before = await deps.read()
  if (wheelDy !== null) await deps.dispatchWheel(wheelDy)

  let prev: ScrollGeometry = before
  let run = 0
  let scrollSeen = false
  let boundaryProven = false
  let samples = 0
  let cur: ScrollGeometry = before

  while (now() - t0 < o.timeoutMs) {
    await deps.sleep(o.sampleMs)
    cur = await deps.read()
    samples += 1

    if (Math.abs(cur.scrollTop - prev.scrollTop) > o.scrollTol) {
      scrollSeen = true
      run = 0
    } else if (frameStable(prev, cur, o) && snapshotAgrees(cur, options.allowedIds)) {
      if (wheelDy === null || scrollSeen) {
        run += 1
      } else {
        // No movement yet: only a deterministic boundary no-op may complete.
        if (
          !boundaryProven &&
          now() - t0 >= o.noScrollGraceMs &&
          Math.abs(cur.scrollTop - before.scrollTop) <= o.scrollTol &&
          isAtBoundary(cur, o.boundaryTol)
        ) {
          boundaryProven = true
        }
        run = boundaryProven ? run + 1 : 0
      }
    } else {
      run = 0
      // A boundary proof is voided by any subsequent instability.
      if (Math.abs(cur.scrollTop - before.scrollTop) > o.scrollTol) boundaryProven = false
    }
    prev = cur

    if (run >= o.stableFrames) {
      return {
        id: cur.anchorId,
        offset: cur.anchorOffset,
        scrollTop: cur.scrollTop,
        scrollHeight: cur.scrollHeight,
        clientHeight: cur.clientHeight,
        phase: cur.phase,
        snapshotId: cur.snapshotId,
        scrollSeen,
        boundaryNoOp: wheelDy !== null && !scrollSeen && boundaryProven,
        samples,
        elapsedMs: now() - t0
      }
    }
  }

  throw new Error(
    `viewport scroll failed to settle within ${o.timeoutMs}ms (dy=${wheelDy === null ? 'none' : wheelDy} ` +
      `samples=${samples} scrollSeen=${scrollSeen ? 1 : 0} boundary=${boundaryProven ? 1 : 0} ` +
      `last=${describeSample(cur)} before=${describeSample(before)})`
  )
}

/** Dispatch a real user wheel, then stabilize with delivery/boundary proof. */
export async function wheelAndSettle(
  deps: ScrollSyncDeps,
  dy: number,
  options: SettleOptions = {}
): Promise<SettleResult> {
  return settleLoop(deps, options, dy)
}

/** Stabilize without dispatching input (post-navigation/route-switch). Returns the stable anchor; throws loudly on timeout. */
export async function waitSettled(deps: ScrollSyncDeps, options: SettleOptions = {}): Promise<SettleResult> {
  return settleLoop(deps, options, null)
}

/**
 * Atomic single-round-trip page read: container geometry + crossing-first
 * anchor (same definition as the specs' `readAnchor`) + controller phase +
 * persisted snapshot id (first key with a parsable id wins).
 * Self-contained for `page.evaluate` serialization (no closures/imports).
 */
export function readScrollGeometry(keys: string[]): {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  phase: string
  anchorId: string
  anchorOffset: number
  snapshotId: string
} {
  const container = document.querySelector('#messages') as HTMLElement | null
  let scrollTop = NaN
  let scrollHeight = NaN
  let clientHeight = NaN
  let phase = ''
  let anchorId = ''
  let anchorOffset = 0
  if (container) {
    scrollTop = container.scrollTop
    scrollHeight = container.scrollHeight
    clientHeight = container.clientHeight
    phase = container.getAttribute('data-viewport-phase') ?? ''
    const c = container.getBoundingClientRect()
    const rows = Array.from(container.querySelectorAll('[data-message-id]')) as HTMLElement[]
    const cands: { id: string; top: number; bottom: number }[] = []
    for (const row of rows) {
      const r = row.getBoundingClientRect()
      const id = row.getAttribute('data-message-id')
      if (id) cands.push({ id, top: r.top, bottom: r.bottom })
    }
    if (cands.length > 0) {
      const crossing = cands.find((x) => x.top <= c.top && x.bottom > c.top) ?? null
      const picked = crossing ?? cands.filter((x) => x.top >= c.top).sort((a, b) => a.top - b.top)[0] ?? cands[0]
      anchorId = picked.id
      anchorOffset = picked.top - c.top
    }
  }
  let snapshotId = ''
  try {
    const w = window as unknown as { keyv?: { get?: (k: string) => unknown } }
    for (const key of keys) {
      let raw: unknown = null
      try {
        raw = w.keyv?.get?.(key) ?? null
      } catch {
        continue
      }
      if (!raw || typeof raw !== 'object') continue
      const rec = raw as Record<string, unknown>
      const mid =
        typeof rec.messageId === 'string' && (rec.messageId as string).length > 0
          ? (rec.messageId as string)
          : typeof rec.anchorId === 'string'
            ? (rec.anchorId as string)
            : ''
      if (mid) {
        snapshotId = mid
        break
      }
    }
  } catch {
    // snapshot stays ''
  }
  return { scrollTop, scrollHeight, clientHeight, phase, anchorId, anchorOffset, snapshotId }
}

async function focusMessages(page: Page): Promise<void> {
  const box = await page.locator('#messages').first().boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}

function pageDeps(page: Page, snapshotKeys: string[]): ScrollSyncDeps {
  return {
    read: () => page.evaluate(readScrollGeometry, snapshotKeys),
    dispatchWheel: async (dy: number) => {
      await focusMessages(page)
      await page.mouse.wheel(0, dy)
    },
    sleep: (ms: number) => page.waitForTimeout(ms)
  }
}

/** Real-wheel + state-driven stabilization against a live page. */
export async function pageWheelAndSettle(
  page: Page,
  snapshotKeys: string[],
  dy: number,
  options: SettleOptions = {}
): Promise<SettleResult> {
  return wheelAndSettle(pageDeps(page, snapshotKeys), dy, options)
}

/** Input-free stabilization against a live page. */
export async function pageWaitSettled(
  page: Page,
  snapshotKeys: string[],
  options: SettleOptions = {}
): Promise<SettleResult> {
  return waitSettled(pageDeps(page, snapshotKeys), options)
}
