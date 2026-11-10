import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * STRUCTURAL wiring guard — NOT an integration test.
 *
 * `Messages` is not mounted here (no existing harness mounts it), so this file
 * asserts the production source contract for the pieces that cannot be reached
 * otherwise: which call sites opt into the frame-ordered publication wait, that
 * the wait sits in the required position inside the fetch-return lifecycle, and
 * that every cancel entry reaches the wait through `cancelActiveLoads`.
 *
 * The behavior of the wait itself (frame ordering, cancellation, hidden,
 * late-callback, resource release) is proven behaviorally in
 * `src/renderer/src/services/__tests__/paginationFrameWait.test.ts`.
 */
describe('Messages frame-ordered publication wiring (structural)', () => {
  const source = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')

  const sliceOf = (startMarker: string, endMarker: string): string => {
    const start = source.indexOf(startMarker)
    expect(start).toBeGreaterThanOrEqual(0)
    const end = source.indexOf(endMarker, start)
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  const loaderSlice = (): string =>
    sliceOf('const startWindowPageLoad', '// One app-owned browse-edge gate for BOTH directions')
  // `cancelActiveLoads` is a short function; the markers around it are far
  // away in the file, so bound the slice by length instead of a start marker.
  const cancelSlice = (): string => {
    const start = source.indexOf('const cancelActiveLoads = useCallback(')
    expect(start).toBeGreaterThanOrEqual(0)
    return source.slice(start, start + 900)
  }

  it('cancels the queued publication frame before releasing the fetch lease', () => {
    const slice = cancelSlice()
    const cancelAllIdx = slice.indexOf('paginationFrameWaitRef.current.cancelAll()')
    const releaseIdx = slice.indexOf('releasePaginationFetchLease(paginationFetchLeaseRef.current)')
    expect(cancelAllIdx).toBeGreaterThanOrEqual(0)
    expect(releaseIdx).toBeGreaterThanOrEqual(0)
    // The frame must be dropped first: cancelling after the forced lease release
    // would leave a queued frame that could still reach the publication tail.
    expect(cancelAllIdx).toBeLessThan(releaseIdx)
    // All four cancel entries (unmount effect, route change, deletion fallback,
    // navigation-cancel helper) share this one function.
    expect((source.match(/cancelActiveLoads\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })

  it('only the ordinary user edge opts in, in the older direction only', () => {
    // The gate is applied to the origin AND the direction.
    expect(loaderSlice()).toMatch(/if \(isFrameOrderedPublicationOrigin\(origin, direction\)\) \{/)
    // The ordinary edge is the only caller passing the opt-in origin.
    expect((source.match(/'ordinary-user-edge'/g) ?? []).length).toBe(1)
    expect(source).toMatch(/void startWindowPageLoad\(direction, null, 'ordinary-user-edge'\)/)
    // Selection boundary and restore-owned divider search keep the default path.
    expect(source).toMatch(/return startWindowPageLoad\(direction\)/)
    expect(source).toMatch(/startWindowPageLoad\('older', decision\.preferred\)/)
  })

  it('waits after the fetch-return guards and before the instant precommit capture', () => {
    const slice = loaderSlice()
    const fetchIdx = slice.indexOf('await runTopicWindowRead(')
    const applicabilityIdx = slice.indexOf('const attemptApplicable = evaluateAttemptApplicable()')
    const responseGuardIdx = slice.indexOf('isValidWindowResponse(request, response')
    const waitIdx = slice.indexOf('await awaitOrdinaryPageFrame(')
    const precommitIdx = slice.indexOf('let precommit:')
    const commitIdx = slice.indexOf('messagesWindowMerged(')
    for (const [name, index] of Object.entries({
      fetchIdx,
      applicabilityIdx,
      responseGuardIdx,
      waitIdx,
      precommitIdx,
      commitIdx
    })) {
      expect(index, `${name} must be present`).toBeGreaterThanOrEqual(0)
    }
    expect(waitIdx).toBeGreaterThan(fetchIdx)
    expect(waitIdx).toBeGreaterThan(applicabilityIdx)
    expect(waitIdx).toBeGreaterThan(responseGuardIdx)
    expect(waitIdx).toBeLessThan(precommitIdx)
    expect(precommitIdx).toBeLessThan(commitIdx)
  })

  it('re-proves every state-dependent guard after the wait', () => {
    const slice = loaderSlice()
    expect(slice).toMatch(/const attemptApplicable = evaluateAttemptApplicable\(\)/)
    // The applicability decision is a reusable closure, evaluated before the
    // wait and again as the post-wait re-proof.
    expect(slice).toMatch(/const evaluateAttemptApplicable = \(\): boolean =>/)
    // Evaluated once before the wait; the same function is then handed to the
    // wait as `stillApplicable`, which re-evaluates it after the frame.
    expect((slice.match(/evaluateAttemptApplicable\(\)/g) ?? []).length).toBe(1)
    // The guards inside the closure are the existing ones, unchanged.
    expect(slice).toMatch(/isCurrentLoad\(direction, loadToken, topicGeneration\) &&/)
    expect(slice).toMatch(/isPaginationAttemptApplicable\(\{/)
    expect(slice).toMatch(/!isDeletionStale\(topicIdAtStart, deletionGenAtStart\)/)
  })

  it('abandons through the existing terminal sequence (no timer, no late publication)', () => {
    const slice = loaderSlice()
    const abandonIdx = slice.indexOf("if (frameStep.step === 'abandon') {")
    expect(abandonIdx).toBeGreaterThanOrEqual(0)
    const abandonBlock = slice.slice(abandonIdx, abandonIdx + 600)
    expect(abandonBlock).toMatch(/releaseOwned\(\)/)
    expect(abandonBlock).toMatch(
      /viewportDispatch\(\{ type: 'load\/cancel', direction, token: loadToken, topicGeneration \}\)/
    )
    expect(abandonBlock).toMatch(/return/)
    // No timer-based bypass is introduced next to the frame wait.
    expect(abandonBlock).not.toMatch(/setTimeout/)
    expect(slice).not.toMatch(/requestAnimationFrame\(/)
  })
})
