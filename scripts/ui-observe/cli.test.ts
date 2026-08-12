/**
 * CLI result-handling tests for `pnpm ui:observe` (`uiObserveCli`).
 *
 * The session runner and the exit/flush hooks are injected through the
 * smallest dependency seam (`UiObserveCliDeps`), so these tests never launch
 * Electron and the `scenarioPending` explicit-exit path is proven without ever
 * terminating the test runner: the injected `forceExit` records the call
 * instead of calling `process.exit`.
 */
import { describe, expect, it, vi } from 'vitest'

import { uiObserveCli } from './cli'
import type { ObservationRunResult, ObservationSessionOptions } from './session'

/** Build a fully-shaped session result with focused overrides. */
function runResult(overrides: Partial<ObservationRunResult>): ObservationRunResult {
  return {
    ok: false,
    scenarioName: 'app-ready',
    scenarioSource: 'builtin:app-ready',
    outputDir: '/out/obs',
    profileDir: '/tmp/profile',
    runtimeAppDataPath: '/tmp/profile',
    chatDbPath: '/tmp/profile/Data/chat.db',
    durationMs: 42,
    artifacts: [],
    error: null,
    cleanupError: null,
    scenarioPending: false,
    ...overrides
  }
}

function io() {
  return {
    stdout: vi.fn<(text: string) => void>(),
    stderr: vi.fn<(text: string) => void>()
  }
}

function runSessionMock(result: ObservationRunResult) {
  return vi.fn<(options: ObservationSessionOptions) => Promise<ObservationRunResult>>().mockResolvedValue(result)
}

describe('uiObserveCli result handling', () => {
  it('returns 0 and never force-exits when the session passes', async () => {
    const writers = io()
    const forceExit = vi.fn<(code: number) => void>()
    const flushStreams = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const runSession = runSessionMock(runResult({ ok: true }))

    const code = await uiObserveCli(['app-ready'], writers, { runSession, forceExit, flushStreams })

    expect(code).toBe(0)
    expect(runSession).toHaveBeenCalledTimes(1)
    expect(forceExit).not.toHaveBeenCalled()
    expect(flushStreams).not.toHaveBeenCalled()
    expect(writers.stdout.mock.calls.join('\n')).toContain('result: PASS')
  })

  it('returns 1 without forcing an exit when the session fails ordinarily', async () => {
    const writers = io()
    const forceExit = vi.fn<(code: number) => void>()
    const flushStreams = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const runSession = runSessionMock(runResult({ ok: false, error: 'scenario crashed' }))

    const code = await uiObserveCli(['app-ready'], writers, { runSession, forceExit, flushStreams })

    expect(code).toBe(1)
    expect(forceExit).not.toHaveBeenCalled()
    expect(flushStreams).not.toHaveBeenCalled()
    expect(writers.stdout.mock.calls.join('\n')).toContain('result: FAIL')
    expect(writers.stderr.mock.calls.join('\n')).toContain('[ui-observe] error: scenario crashed')
  })

  it('prints the pending notice and force-exits only after the report is written and streams are flushed', async () => {
    const writers = io()
    const forceExit = vi.fn<(code: number) => void>()
    const flushStreams = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const runSession = runSessionMock(
      runResult({ ok: false, scenarioPending: true, error: 'scenario timed out after 1ms' })
    )

    const code = await uiObserveCli(['app-ready'], writers, { runSession, forceExit, flushStreams })

    expect(code).toBe(1)
    expect(forceExit).toHaveBeenCalledTimes(1)
    expect(forceExit).toHaveBeenCalledWith(1)
    expect(flushStreams).toHaveBeenCalledTimes(1)

    const stdoutText = writers.stdout.mock.calls.join('\n')
    const stderrText = writers.stderr.mock.calls.join('\n')
    expect(stdoutText).toContain('result: FAIL')
    expect(stderrText).toContain('still pending after cleanup — exiting explicitly')

    // The explicit exit follows only after the final report is written and
    // both output streams are flushed (cleanup-before-exit preserved).
    const lastStdoutOrder = Math.max(...writers.stdout.mock.invocationCallOrder)
    const lastStderrOrder = Math.max(...writers.stderr.mock.invocationCallOrder)
    const flushOrder = flushStreams.mock.invocationCallOrder[0]
    const exitOrder = forceExit.mock.invocationCallOrder[0]
    expect(lastStdoutOrder).toBeLessThan(flushOrder)
    expect(lastStderrOrder).toBeLessThan(flushOrder)
    expect(flushOrder).toBeLessThan(exitOrder)
  })
})
