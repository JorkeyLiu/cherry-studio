import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * Bootstrap prepare-around rail contract (source-level pins; request-rail
 * behavior is exercised in `messageThunk.bootstrapAroundRestore.test.ts`
 * with the real thunks and the existing window model — no user-chat
 * fixtures):
 *
 * - The bootstrap PREPARE entry (`prepareNavigationTarget`) runs the shared
 *   target-load stage with the thunk-owner read (`viaRouteThunk: true`): the
 *   injected around read is served by the unique deferred entry
 *   `dispatchDeferredRouteWindowRead({ kind: 'around', ... })` (single
 *   flight that registers synchronously in the shared request map, so a
 *   later same-topic same-route bootstrap latest adopts it). The thunk
 *   publishes nothing itself; the stage keeps its existing atomic
 *   staged-merge publication (`messagesWindowMerged` + projection commit)
 *   outside the injected read — no second non-atomic cover, no naked DB
 *   read on the thunk rail, never the rebase joint payload.
 * - The FULL user-navigation entry keeps the direct caller-merge read (no
 *   `viaRouteThunk` flag): canonical ensure → staged merge.
 * - Same-request adoption is proven by the sync `onRawDispatched` hook
 *   (registration-time promise identity + route) promoting the prepare
 *   baseline from the dispatch-source publication token (never by
 *   re-reading the resident registry, never a second fetch).
 * - The same receipt that carried the read guards the final merge commit
 *   via the shared pure checker `isDeferredRouteWindowReceiptCurrent`.
 * - All stale gates stay intact on the thunk rail (topic/navigate/
 *   transition/deletion/resident + route + projection-commit wait).
 *
 * Every slice below is bounded by the product function it names, so an
 * assertion about the stage cannot silently range over the rest of the file.
 */
describe('bootstrap prepare-around thunk-owner rail', () => {
  const messagesSource = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')

  // Shared target-load stage (`ensureNavigationTargetReady`): bounded by its
  // own declaration and the following entry declaration.
  const stageStart = messagesSource.indexOf('const ensureNavigationTargetReady = useCallback(')
  const stageEnd = messagesSource.indexOf('const navigate = useCallback(', stageStart)
  const stageSource = messagesSource.slice(stageStart, stageEnd)
  // The thunk branch is injected INSIDE the `ensureMessageLoaded(...)` call
  // arguments (the `readAroundWindow` injection), so the shared
  // `const ensured = await ...` line sits BEFORE `railStart`, not after it.
  // Slice the deferred branch (rail → naked DB import) and the shared tail
  // (from the terminal-contract dispatch after the ensure call closes).
  const railStart = stageSource.indexOf('if (args.viaRouteThunk === true)')
  const dbImportIdx = stageSource.indexOf('const { dbService }', railStart)
  const tailStart = stageSource.indexOf("if (ensured.status === 'cancelled')", dbImportIdx)

  // The two navigation entries, each bounded by its own declaration and the
  // next entry declaration in the same component.
  const fullStart = messagesSource.indexOf('const navigate = useCallback(')
  const fullEnd = messagesSource.indexOf('const navigateAndSave = useCallback(', fullStart)
  const fullEntry = messagesSource.slice(fullStart, fullEnd)
  const prepareStart = messagesSource.indexOf('const prepareNavigationTarget = useCallback(')
  const prepareEnd = messagesSource.indexOf('const scrollToGroup = useCallback(', prepareStart)
  const prepareEntry = messagesSource.slice(prepareStart, prepareEnd)

  it('declares the rail selector on the shared stage', () => {
    expect(stageStart).toBeGreaterThanOrEqual(0)
    expect(stageEnd).toBeGreaterThan(stageStart)
    expect(railStart).toBeGreaterThanOrEqual(0)
    expect(dbImportIdx).toBeGreaterThan(railStart)
    expect(tailStart).toBeGreaterThan(dbImportIdx)
    expect(stageSource).toMatch(/viaRouteThunk\?: boolean/)
    expect(stageSource).toMatch(/onDeferredAroundDispatched\?: \(dispatchedPromise: unknown\) => void/)
  })

  it('routes only the bootstrap prepare entry through the thunk rail', () => {
    // Exactly one code caller: the bootstrap prepare entry. The FULL
    // navigating entry keeps the direct caller-merge read (no flag).
    expect(fullStart).toBeGreaterThanOrEqual(0)
    expect(fullEnd).toBeGreaterThan(fullStart)
    expect(prepareStart).toBeGreaterThanOrEqual(0)
    expect(prepareEnd).toBeGreaterThan(prepareStart)
    // Code call sites only (the prose mention in the stage JSDoc carries no
    // trailing comma), so the count pins the single flagged caller.
    const flagged = messagesSource.match(/viaRouteThunk: true,/g) ?? []
    expect(flagged.length).toBe(1)
    // Both entries own their target-load through the SAME shared stage.
    expect(fullEntry).toMatch(/await ensureNavigationTargetReady\(/)
    expect(prepareEntry).toMatch(/await ensureNavigationTargetReady\(/)
    // Only the prepare entry enables the thunk rail and the adoption hook.
    expect(prepareEntry).toMatch(/viaRouteThunk: true/)
    expect(prepareEntry).toMatch(/onDeferredAroundDispatched: \(dispatchedPromise\) =>/)
    expect(fullEntry).not.toMatch(/viaRouteThunk/)
    expect(fullEntry).not.toMatch(/onDeferredAroundDispatched/)
  })

  it('the thunk rail single-flights through the unique deferred entry and the stage keeps its merge', () => {
    // Injection-level branch only: the deferred slice runs before the naked
    // DB import; the direct read below it is the untouched FULL path.
    const deferred = stageSource.slice(railStart, dbImportIdx)
    // Single flight: unique deferred entry, around anchored at the target
    // with the canonical navigation quotas (before/after echo the loader).
    expect(deferred).toMatch(/dispatchDeferredRouteWindowRead\(/)
    expect(deferred).toMatch(/kind:\s*'around'/)
    expect(deferred).toMatch(/anchorMessageId:\s*targetId/)
    expect(deferred).toMatch(/NAVIGATION_VISUALLY_OLDER_GROUPS/)
    expect(deferred).toMatch(/NAVIGATION_VISUALLY_NEWER_GROUPS/)
    // Deferred: the entry publishes nothing; this stage keeps its existing
    // atomic staged-merge publication below (never the rebase joint payload).
    expect(deferred).not.toMatch(/toDeferredJointPayload/)
    expect(deferred).not.toMatch(/loadRouteMessagesThunk\(topicIdAtStart, routeAtStart/)
    // Sync hook preserves registration-time promise identity: the wrapper
    // invokes `onRawDispatched` synchronously after dispatch (before the
    // first await), and the stage forwards it to the adoption callback.
    expect(deferred).toMatch(/onRawDispatched/)
    expect(deferred).toMatch(/args\.onDeferredAroundDispatched\?/)
    // The receipt binds the same registration for the final currency check.
    expect(deferred).toMatch(/viaRouteReceipt/)
    // A stale-discarded deferred read (void) throws so the loader maps it to
    // retryable `error` (stage `cancelled`, pending preserved) — the loader's
    // own post-fetch stale gate runs first when it trips.
    expect(deferred).toMatch(/around route read discarded as stale/)
    // No naked read on the thunk rail: no direct DB, no window-queue read,
    // no merge/block upsert/rebase of its own.
    expect(deferred).not.toMatch(/fetchMessagesWindow/)
    expect(deferred).not.toMatch(/dbService/)
    expect(deferred).not.toMatch(/runTopicWindowRead/)
    expect(deferred).not.toMatch(/messagesWindowMerged/)
    expect(deferred).not.toMatch(/upsertManyBlocks/)
    expect(deferred).not.toMatch(/rebaseRouteMessages/)
    expect(deferred).not.toMatch(/ensureMessageLoaded/)
    // The FULL direct path below is untouched: still a routed naked window read.
    const direct = stageSource.slice(dbImportIdx, tailStart)
    expect(direct).toMatch(/fetchMessagesWindow/)
    expect(direct).toMatch(/runTopicWindowRead/)
    // The stage merge publication lives outside (after) the injected read and
    // is unchanged: blocks then merged messages + projection commit, guarded
    // by the same receipt's final currency check.
    const sharedTail = stageSource.slice(tailStart)
    expect(sharedTail).toMatch(/messagesWindowMerged/)
    expect(sharedTail).toMatch(/isDeferredRouteWindowReceiptCurrent\(\(\) => store\.getState\(\), viaRouteReceipt\)/)
    expect(sharedTail).toMatch(/waitForProjectionCommit\(targetId, isStale\)/)
  })

  it('the thunk rail keeps every stale gate and the terminal contract', () => {
    const rail = stageSource.slice(railStart, tailStart)
    // Pre/post fetch staleness closures consult the live closure (plus route).
    expect(rail).toMatch(/isStaleBeforeFetch: \(\) => isStale\(\) \|\| routeRef\.current !== routeAtStart/)
    expect(rail).toMatch(/isStaleAfterFetch: \(\) => isStale\(\) \|\| routeRef\.current !== routeAtStart/)
    // The synchronous handoff used for same-request adoption is present on the
    // rail (dispatch → sync hook → await).
    expect(rail).toMatch(/onRawDispatched/)
    // Shared terminal contract after the injected read: resident `ready`,
    // authoritative missing `not-found` with the single toast,
    // transport/unknown/malformed preserve pending via `cancelled`.
    const sharedTail = stageSource.slice(tailStart)
    expect(sharedTail).toMatch(/ensured\.status === 'not-found'/)
    expect(sharedTail).toMatch(/message_not_found/)
    expect(sharedTail).toMatch(/return 'not-found'/)
    expect(sharedTail).toMatch(/return 'ready'/)
    expect(sharedTail).toMatch(/return 'cancelled'/)
    // Every check/wait site still consults the live staleness closure: the
    // resident fast path, the authoritative not-found path, the pre-publication
    // check, the receipt final gate, and the post-projection-wait check.
    expect(sharedTail.match(/if \(isStale\(\)\) \{/g) ?? []).toHaveLength(4)
    expect(sharedTail).toMatch(/if \(args\.viaRouteThunk === true\)/)
    // The projection-commit wait is terminal on timeout (never an infinite
    // hold): an uncommitted projection cancels.
    expect(sharedTail).toMatch(/if \(!committed\) \{\s*return 'cancelled'\s*\}/)
  })
})
