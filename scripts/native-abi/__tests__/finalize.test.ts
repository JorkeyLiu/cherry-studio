import { describe, expect, it } from 'vitest'

import {
  CHILD_SPAWN_ERROR_EXIT_CODE,
  type ChildResult,
  type ChildRun,
  computeFinalizeExitCode,
  type FinalizeOperations,
  finalizeOuterLane,
  type FinalizeOuterLaneParams,
  type FinalizeOuterLaneResult,
  type LaneId,
  RELEASE_FAILURE_EXIT_CODE,
  type ReleaseResult,
  RESTORE_FAILURE_EXIT_CODE,
  type RestoreResult,
  shouldRestoreElectron,
  TARGET_PREPARATION_FAILURE_EXIT_CODE
} from '../finalize'

// ---------------------------------------------------------------------------
// Deterministic fakes: a scripted operations seam that records call order so
// the required ordering (child → restore → release) is provable. No real
// child, filesystem, signal, or lock module is involved.
// ---------------------------------------------------------------------------

class FakeOperations implements FinalizeOperations {
  restoreResults: RestoreResult[] = []
  restoreErrors: unknown[] = []
  restoreCalls = 0

  releaseResults: ReleaseResult[] = []
  releaseErrors: unknown[] = []
  releaseCalls = 0

  childResults: ChildResult[] = []
  childErrors: unknown[] = []
  childCalls = 0

  /** Shared operation-order log (child / restore / release). */
  order: string[] = []

  async restore(): Promise<RestoreResult> {
    this.order.push('restore')
    this.restoreCalls += 1
    const err = this.restoreErrors.shift()
    if (err !== undefined) {
      throw err
    }
    const next = this.restoreResults.shift()
    if (next === undefined) {
      throw new Error('FakeOperations: no scripted restore result')
    }
    return next
  }

  release(): ReleaseResult {
    this.order.push('release')
    this.releaseCalls += 1
    const err = this.releaseErrors.shift()
    if (err !== undefined) {
      throw err
    }
    const next = this.releaseResults.shift()
    if (next === undefined) {
      throw new Error('FakeOperations: no scripted release result')
    }
    return next
  }

  async runChild(): Promise<ChildResult> {
    this.order.push('child')
    this.childCalls += 1
    const err = this.childErrors.shift()
    if (err !== undefined) {
      throw err
    }
    const next = this.childResults.shift()
    if (next === undefined) {
      throw new Error('FakeOperations: no scripted child result')
    }
    return next
  }
}

function childExited(code: number): ChildResult {
  return { kind: 'exited', code }
}

function childSignaled(signal: NodeJS.Signals, exitCode: number): ChildResult {
  return { kind: 'signaled', signal, exitCode }
}

function childSpawnError(message = 'spawn failed'): ChildResult {
  return { kind: 'spawn-error', message }
}

const restoreOk: RestoreResult = { status: 'performed', ok: true }
const restoreFailed: RestoreResult = { status: 'performed', ok: false }
const LOCK_PATH = '/repo/.native-abi-lock'
const releaseOk: ReleaseResult = { released: true, lockPath: LOCK_PATH }
const releaseFailed: ReleaseResult = { released: false, reason: 'error', error: 'unlink EACCES', lockPath: LOCK_PATH }

const ran = (outcome: ChildResult): ChildRun => ({ ran: true, outcome })
const notRan = (error = 'target lane could not be ensured'): ChildRun => ({
  ran: false,
  reason: 'target-preparation-failure',
  error
})

class Harness {
  operations = new FakeOperations()
  order = this.operations.order

  params(overrides: Partial<FinalizeOuterLaneParams> = {}): FinalizeOuterLaneParams {
    return {
      lane: 'node',
      ci: false,
      childRequired: true,
      operations: this.operations,
      ...overrides
    }
  }
}

/** Default happy path: child 0, restore ok, release ok, local Node. */
function scriptHappy(h: Harness): void {
  h.operations.childResults.push(childExited(0))
  h.operations.restoreResults.push(restoreOk)
  h.operations.releaseResults.push(releaseOk)
}

// ---------------------------------------------------------------------------

describe('finalizeOuterLane — child execution', () => {
  it('runs the child via the runChild seam exactly once when requested and preserves the outcome', async () => {
    const h = new Harness()
    scriptHappy(h)

    const result = await finalizeOuterLane(h.params({}))

    expect(h.operations.childCalls).toBe(1)
    expect(result.child).toEqual(ran(childExited(0)))
    expect(result.exitCode).toBe(0)
  })

  it('orders child → restore → release for a local outer Node lane', async () => {
    const h = new Harness()
    scriptHappy(h)

    await finalizeOuterLane(h.params({}))

    expect(h.order).toEqual(['child', 'restore', 'release'])
  })

  it('does not run the child when childRequired is false (target preparation failure)', async () => {
    const h = new Harness()
    h.operations.restoreResults.push(restoreOk)
    h.operations.releaseResults.push(releaseOk)

    const result = await finalizeOuterLane(
      h.params({ childRequired: false, targetPreparationFailure: { error: 'rebuild failed: EACCES' } })
    )

    expect(h.operations.childCalls).toBe(0)
    expect(result.child).toEqual(notRan('rebuild failed: EACCES'))
  })

  it('uses the supplied child outcome when no runChild seam is provided', async () => {
    const operations: FinalizeOperations = {
      restore: async () => restoreOk,
      release: () => releaseOk
    }

    const result = await finalizeOuterLane({
      lane: 'node',
      ci: false,
      childRequired: true,
      child: childExited(3),
      operations
    })

    expect(result.child).toEqual(ran(childExited(3)))
    expect(result.exitCode).toBe(3)
  })

  it('treats a missing child outcome without a runChild seam as a deterministic spawn-error', async () => {
    const operations: FinalizeOperations = {
      restore: async () => restoreOk,
      release: () => releaseOk
    }

    const result = await finalizeOuterLane({
      lane: 'node',
      ci: false,
      childRequired: true,
      operations
    })

    expect(result.child).toEqual(ran({ kind: 'spawn-error', message: 'no child result supplied and no runChild seam' }))
    expect(result.exitCode).toBe(CHILD_SPAWN_ERROR_EXIT_CODE)
  })

  it('turns a rejecting runChild seam into a spawn-error outcome and still restores and releases', async () => {
    const h = new Harness()
    h.operations.childErrors.push(new Error('child boom'))
    h.operations.restoreResults.push(restoreOk)
    h.operations.releaseResults.push(releaseOk)

    const result = await finalizeOuterLane(h.params({}))

    expect(result.child).toEqual(ran({ kind: 'spawn-error', message: 'child boom' }))
    expect(h.operations.childCalls).toBe(1)
    expect(h.operations.restoreCalls).toBe(1)
    expect(h.operations.releaseCalls).toBe(1)
    expect(result.exitCode).toBe(CHILD_SPAWN_ERROR_EXIT_CODE)
  })

  it('prefers the runChild seam outcome over a conflicting supplied child', async () => {
    const h = new Harness()
    h.operations.childResults.push(childExited(0))
    h.operations.restoreResults.push(restoreOk)
    h.operations.releaseResults.push(releaseOk)

    const result = await finalizeOuterLane(h.params({ child: childExited(7) }))

    expect(h.operations.childCalls).toBe(1)
    expect(result.child).toEqual(ran(childExited(0)))
    expect(result.exitCode).toBe(0)
  })
})

describe('finalizeOuterLane — child outcomes map to exit codes', () => {
  it('exit 0 child with restore ok and release ok yields exit code 0', async () => {
    const h = new Harness()
    scriptHappy(h)

    const result = await finalizeOuterLane(h.params({}))

    expect(result.exitCode).toBe(0)
    expect(result.restore).toEqual(restoreOk)
    expect(result.release).toEqual(releaseOk)
  })

  it('preserves a nonzero child exit code over restore and release failures', async () => {
    const h = new Harness()
    h.operations.childResults.push(childExited(7))
    h.operations.restoreResults.push(restoreFailed)
    h.operations.releaseResults.push(releaseFailed)

    const result = await finalizeOuterLane(h.params({}))

    expect(result.exitCode).toBe(7)
    expect(result.child).toEqual(ran(childExited(7)))
    // The restore/release failures stay observable in the structured result.
    expect(result.restore).toEqual(restoreFailed)
    expect(result.release).toEqual(releaseFailed)
    expect(h.operations.restoreCalls).toBe(1)
    expect(h.operations.releaseCalls).toBe(1)
  })

  it('maps a signaled child to its deterministic conventional exit code', async () => {
    const h = new Harness()
    h.operations.childResults.push(childSignaled('SIGTERM', 143))
    h.operations.restoreResults.push(restoreOk)
    h.operations.releaseResults.push(releaseOk)

    const result = await finalizeOuterLane(h.params({}))

    expect(result.exitCode).toBe(143)
    expect(result.child).toEqual(ran(childSignaled('SIGTERM', 143)))
  })

  it('a signaled child with exitCode 0 behaves like a successful child and falls through to restore failure precedence', async () => {
    const h = new Harness()
    h.operations.childResults.push(childSignaled('SIGTERM', 0))
    h.operations.restoreResults.push(restoreFailed)
    h.operations.releaseResults.push(releaseOk)

    const result = await finalizeOuterLane(h.params({}))

    expect(result.child).toEqual(ran(childSignaled('SIGTERM', 0)))
    expect(result.exitCode).toBe(RESTORE_FAILURE_EXIT_CODE)
  })

  it('maps a spawn-error child to CHILD_SPAWN_ERROR_EXIT_CODE', async () => {
    const h = new Harness()
    h.operations.childResults.push(childSpawnError('spawn /no/such ENOENT'))
    h.operations.restoreResults.push(restoreOk)
    h.operations.releaseResults.push(releaseOk)

    const result = await finalizeOuterLane(h.params({}))

    expect(result.exitCode).toBe(CHILD_SPAWN_ERROR_EXIT_CODE)
    expect(result.child).toEqual(ran(childSpawnError('spawn /no/such ENOENT')))
  })
})

describe('finalizeOuterLane — restore policy (LOCK-003)', () => {
  it('runs restore after the child outcome and before the release for local outer Node', async () => {
    const h = new Harness()
    scriptHappy(h)

    await finalizeOuterLane(h.params({}))

    expect(h.operations.restoreCalls).toBe(1)
    expect(h.order).toEqual(['child', 'restore', 'release'])
  })

  it('skips restoration for a CI Node lane (ci-skip) and never consults the restore seam', async () => {
    const h = new Harness()
    // No restore result scripted: consulting the seam would throw.
    h.operations.childResults.push(childExited(0))
    h.operations.releaseResults.push(releaseOk)

    const result = await finalizeOuterLane(h.params({ ci: true }))

    expect(h.operations.restoreCalls).toBe(0)
    expect(result.restore).toEqual({ status: 'skipped', reason: 'ci-skip' })
    expect(result.exitCode).toBe(0)
    expect(h.order).toEqual(['child', 'release'])
  })

  it('never restores for an Electron lane (non-node-lane)', async () => {
    const h = new Harness()
    h.operations.childResults.push(childExited(0))
    h.operations.releaseResults.push(releaseOk)

    const result = await finalizeOuterLane(h.params({ lane: 'electron' }))

    expect(h.operations.restoreCalls).toBe(0)
    expect(result.restore).toEqual({ status: 'skipped', reason: 'non-node-lane' })
    expect(result.exitCode).toBe(0)
  })

  it('an Electron lane in CI also skips with the non-node-lane reason', async () => {
    const h = new Harness()
    h.operations.childResults.push(childExited(0))
    h.operations.releaseResults.push(releaseOk)

    const result = await finalizeOuterLane(h.params({ lane: 'electron', ci: true }))

    expect(result.restore).toEqual({ status: 'skipped', reason: 'non-node-lane' })
  })

  it('a failed restoration yields RESTORE_FAILURE_EXIT_CODE when the child succeeded', async () => {
    const h = new Harness()
    h.operations.childResults.push(childExited(0))
    h.operations.restoreResults.push(restoreFailed)
    h.operations.releaseResults.push(releaseOk)

    const result = await finalizeOuterLane(h.params({}))

    expect(result.exitCode).toBe(RESTORE_FAILURE_EXIT_CODE)
    expect(result.restore).toEqual(restoreFailed)
  })

  it('a rejecting restore seam is an observable rejected result and release still runs', async () => {
    const h = new Harness()
    h.operations.childResults.push(childExited(0))
    h.operations.restoreErrors.push(new Error('restore boom'))
    h.operations.releaseResults.push(releaseOk)

    const result = await finalizeOuterLane(h.params({}))

    expect(result.restore).toEqual({ status: 'rejected', error: 'restore boom' })
    expect(h.operations.releaseCalls).toBe(1)
    expect(result.exitCode).toBe(RESTORE_FAILURE_EXIT_CODE)
  })
})

describe('finalizeOuterLane — release', () => {
  it('releases the outer lock exactly once after restore', async () => {
    const h = new Harness()
    scriptHappy(h)

    await finalizeOuterLane(h.params({}))

    expect(h.operations.releaseCalls).toBe(1)
    expect(h.order[h.order.length - 1]).toBe('release')
  })

  it('still releases exactly once when the child failed (child code stays the exit code)', async () => {
    const h = new Harness()
    h.operations.childResults.push(childExited(9))
    h.operations.restoreResults.push(restoreOk)
    h.operations.releaseResults.push(releaseOk)

    const result = await finalizeOuterLane(h.params({}))

    expect(result.exitCode).toBe(9)
    expect(h.operations.releaseCalls).toBe(1)
    expect(h.order).toEqual(['child', 'restore', 'release'])
  })

  it('still releases exactly once when the restore failed', async () => {
    const h = new Harness()
    h.operations.childResults.push(childExited(0))
    h.operations.restoreResults.push(restoreFailed)
    h.operations.releaseResults.push(releaseOk)

    const result = await finalizeOuterLane(h.params({}))

    expect(result.exitCode).toBe(RESTORE_FAILURE_EXIT_CODE)
    expect(h.operations.releaseCalls).toBe(1)
  })

  it('a failed release yields RELEASE_FAILURE_EXIT_CODE when child and restore succeeded', async () => {
    const h = new Harness()
    h.operations.childResults.push(childExited(0))
    h.operations.restoreResults.push(restoreOk)
    h.operations.releaseResults.push(releaseFailed)

    const result = await finalizeOuterLane(h.params({}))

    expect(result.exitCode).toBe(RELEASE_FAILURE_EXIT_CODE)
    expect(result.release).toEqual(releaseFailed)
  })

  it('a rejecting release seam is an observable error release result', async () => {
    const h = new Harness()
    h.operations.childResults.push(childExited(0))
    h.operations.restoreResults.push(restoreOk)
    h.operations.releaseErrors.push(new Error('release boom'))

    const result = await finalizeOuterLane(h.params({}))

    expect(result.release).toEqual({ released: false, reason: 'error', error: 'release boom', lockPath: '' })
    expect(result.exitCode).toBe(RELEASE_FAILURE_EXIT_CODE)
  })

  it('surfaces the supplied lockPath in the release result when the release seam rejects', async () => {
    const h = new Harness()
    h.operations.childResults.push(childExited(0))
    h.operations.restoreResults.push(restoreOk)
    h.operations.releaseErrors.push(new Error('release boom'))

    const result = await finalizeOuterLane(h.params({ lockPath: LOCK_PATH }))

    expect(result.release).toEqual({ released: false, reason: 'error', error: 'release boom', lockPath: LOCK_PATH })
    expect(result.exitCode).toBe(RELEASE_FAILURE_EXIT_CODE)
  })
})

describe('finalizeOuterLane — target preparation failure', () => {
  it('preserves the failure, never runs the child, and still restores and releases for local Node', async () => {
    const h = new Harness()
    h.operations.restoreResults.push(restoreOk)
    h.operations.releaseResults.push(releaseOk)

    const result = await finalizeOuterLane(
      h.params({ childRequired: false, targetPreparationFailure: { error: 'verify failed: post-check boom' } })
    )

    expect(h.operations.childCalls).toBe(0)
    expect(result.child).toEqual(notRan('verify failed: post-check boom'))
    expect(result.lane).toBe('node')
    expect(h.operations.restoreCalls).toBe(1)
    expect(h.operations.releaseCalls).toBe(1)
    expect(h.order).toEqual(['restore', 'release'])
    expect(result.exitCode).toBe(TARGET_PREPARATION_FAILURE_EXIT_CODE)
  })

  it('a target preparation failure in CI skips restore but still releases exactly once', async () => {
    const h = new Harness()
    h.operations.releaseResults.push(releaseOk)

    const result = await finalizeOuterLane(
      h.params({ childRequired: false, ci: true, targetPreparationFailure: { error: 'ensure rejected' } })
    )

    expect(h.operations.restoreCalls).toBe(0)
    expect(result.restore).toEqual({ status: 'skipped', reason: 'ci-skip' })
    expect(h.operations.releaseCalls).toBe(1)
    expect(result.exitCode).toBe(TARGET_PREPARATION_FAILURE_EXIT_CODE)
  })

  it('a target preparation failure on an Electron lane skips restore but still releases', async () => {
    const h = new Harness()
    h.operations.releaseResults.push(releaseOk)

    const result = await finalizeOuterLane(
      h.params({
        lane: 'electron',
        childRequired: false,
        targetPreparationFailure: { error: 'electron ensure failed' }
      })
    )

    expect(result.restore).toEqual({ status: 'skipped', reason: 'non-node-lane' })
    expect(h.operations.releaseCalls).toBe(1)
    expect(result.exitCode).toBe(TARGET_PREPARATION_FAILURE_EXIT_CODE)
  })
})

describe('computeFinalizeExitCode — precedence matrix (LOCK-006)', () => {
  const ok = { restore: restoreOk, release: releaseOk }

  it('child exit 0 with restore ok and release ok → 0', () => {
    expect(computeFinalizeExitCode({ child: ran(childExited(0)), ...ok })).toBe(0)
  })

  it('child exit 0 with restore skipped and release ok → 0', () => {
    expect(
      computeFinalizeExitCode({
        child: ran(childExited(0)),
        restore: { status: 'skipped', reason: 'ci-skip' },
        release: releaseOk
      })
    ).toBe(0)
  })

  it('restore failure beats release failure when the child succeeded', () => {
    expect(
      computeFinalizeExitCode({ child: ran(childExited(0)), restore: restoreFailed, release: releaseFailed })
    ).toBe(RESTORE_FAILURE_EXIT_CODE)
  })

  it('a rejected restore is the same failure as a performed non-ok restore', () => {
    expect(
      computeFinalizeExitCode({
        child: ran(childExited(0)),
        restore: { status: 'rejected', error: 'boom' },
        release: releaseOk
      })
    ).toBe(RESTORE_FAILURE_EXIT_CODE)
  })

  it('release failure is returned only when child and restore both succeeded', () => {
    expect(computeFinalizeExitCode({ child: ran(childExited(0)), restore: restoreOk, release: releaseFailed })).toBe(
      RELEASE_FAILURE_EXIT_CODE
    )
    expect(
      computeFinalizeExitCode({
        child: ran(childExited(0)),
        restore: { status: 'skipped', reason: 'non-node-lane' },
        release: releaseFailed
      })
    ).toBe(RELEASE_FAILURE_EXIT_CODE)
  })

  it('a failing child always beats restore and release failures', () => {
    expect(
      computeFinalizeExitCode({ child: ran(childExited(7)), restore: restoreFailed, release: releaseFailed })
    ).toBe(7)
    expect(
      computeFinalizeExitCode({
        child: ran(childSignaled('SIGTERM', 143)),
        restore: restoreFailed,
        release: releaseFailed
      })
    ).toBe(143)
    expect(
      computeFinalizeExitCode({ child: ran(childSpawnError('ENOENT')), restore: restoreFailed, release: releaseFailed })
    ).toBe(CHILD_SPAWN_ERROR_EXIT_CODE)
  })

  it('a signaled child with exitCode 0 is a child success and falls through to restore/release checks', () => {
    expect(
      computeFinalizeExitCode({
        child: ran(childSignaled('SIGTERM', 0)),
        restore: restoreFailed,
        release: releaseFailed
      })
    ).toBe(RESTORE_FAILURE_EXIT_CODE)
    expect(
      computeFinalizeExitCode({
        child: ran(childSignaled('SIGTERM', 0)),
        restore: restoreOk,
        release: releaseFailed
      })
    ).toBe(RELEASE_FAILURE_EXIT_CODE)
    expect(
      computeFinalizeExitCode({
        child: ran(childSignaled('SIGTERM', 0)),
        restore: restoreOk,
        release: releaseOk
      })
    ).toBe(0)
  })

  it('a target preparation failure always beats restore and release failures', () => {
    expect(computeFinalizeExitCode({ child: notRan(), restore: restoreFailed, release: releaseFailed })).toBe(
      TARGET_PREPARATION_FAILURE_EXIT_CODE
    )
    expect(computeFinalizeExitCode({ child: notRan(), restore: restoreOk, release: releaseOk })).toBe(
      TARGET_PREPARATION_FAILURE_EXIT_CODE
    )
  })
})

describe('shouldRestoreElectron (LOCK-003) — pure policy', () => {
  it('restores only for a local outer Node lane', () => {
    expect(shouldRestoreElectron({ lane: 'node', ci: false })).toBe(true)
    expect(shouldRestoreElectron({ lane: 'node', ci: true })).toBe(false)
    expect(shouldRestoreElectron({ lane: 'electron', ci: false })).toBe(false)
    expect(shouldRestoreElectron({ lane: 'electron', ci: true })).toBe(false)
  })
})

describe('finalizeOuterLane — structured result surface', () => {
  it('returns the lane and all structured statuses', async () => {
    const h = new Harness()
    scriptHappy(h)

    const result: FinalizeOuterLaneResult = await finalizeOuterLane(h.params({ lane: 'node' as LaneId }))

    expect(result.lane).toBe('node')
    expect(result.child).toHaveProperty('ran', true)
    expect(result.restore).toHaveProperty('status', 'performed')
    expect(result.release).toHaveProperty('released', true)
    expect(result.exitCode).toBe(0)
  })
})
