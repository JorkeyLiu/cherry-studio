/**
 * Bounded supervisor stdout EPIPE semantics:
 * - only `code === 'EPIPE'` is swallowed, sync and async;
 * - the broken sink stops further writes;
 * - unrelated errors propagate exactly as bare `process.stdout.write` would;
 * - guard install is idempotent (no duplicate listeners).
 */
import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ensureSupervisorStdoutGuard,
  isSupervisorBrokenPipeError,
  isSupervisorStdoutBroken,
  resetSupervisorOutputGuardForTests,
  writeSupervisorStdout
} from '../outputGuard'

function epipeError(): NodeJS.ErrnoException {
  const error = new Error('write EPIPE') as NodeJS.ErrnoException
  error.code = 'EPIPE'
  return error
}

beforeEach(() => {
  resetSupervisorOutputGuardForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetSupervisorOutputGuardForTests()
})

describe('isSupervisorBrokenPipeError', () => {
  it('matches only the EPIPE code shape', () => {
    expect(isSupervisorBrokenPipeError(epipeError())).toBe(true)
    expect(isSupervisorBrokenPipeError({ code: 'ENOSPC' })).toBe(false)
    expect(isSupervisorBrokenPipeError(new Error('boom'))).toBe(false)
    expect(isSupervisorBrokenPipeError(null)).toBe(false)
  })
})

describe('writeSupervisorStdout', () => {
  it('swallows a synchronous EPIPE and stops the sink', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementationOnce(() => {
      throw epipeError()
    })

    expect(() => writeSupervisorStdout('[dev-sync] bye\n')).not.toThrow()
    expect(isSupervisorStdoutBroken()).toBe(true)

    // Broken sink is skipped from here on.
    writeSupervisorStdout('[dev-sync] never written\n')
    expect(writeSpy).toHaveBeenCalledTimes(1)
  })

  it('rethrows unrelated write errors and keeps the sink open', () => {
    const busy = Object.assign(new Error('no space'), { code: 'ENOSPC' })
    vi.spyOn(process.stdout, 'write').mockImplementationOnce(() => {
      throw busy
    })

    expect(() => writeSupervisorStdout('[dev-sync] unlucky\n')).toThrow(busy)
    expect(isSupervisorStdoutBroken()).toBe(false)
  })
})

describe('ensureSupervisorStdoutGuard', () => {
  it('installs exactly once across repeated init', () => {
    const stdout = new EventEmitter()
    ensureSupervisorStdoutGuard(stdout as unknown as NodeJS.WriteStream)
    ensureSupervisorStdoutGuard(stdout as unknown as NodeJS.WriteStream)
    ensureSupervisorStdoutGuard(stdout as unknown as NodeJS.WriteStream)
    expect(stdout.listenerCount('error')).toBe(1)
  })

  it('swallows an async EPIPE and rethrows unrelated stream errors', () => {
    const stdout = new EventEmitter()
    ensureSupervisorStdoutGuard(stdout as unknown as NodeJS.WriteStream)

    expect(() => stdout.emit('error', epipeError())).not.toThrow()
    expect(isSupervisorStdoutBroken()).toBe(true)

    const busy = Object.assign(new Error('boom'), { code: 'ENOSPC' })
    expect(() => stdout.emit('error', busy)).toThrow(busy)
  })

  it('handles repeated async EPIPE events with a single persistent listener', () => {
    const stdout = new EventEmitter()
    ensureSupervisorStdoutGuard(stdout as unknown as NodeJS.WriteStream)

    expect(() => stdout.emit('error', epipeError())).not.toThrow()
    expect(isSupervisorStdoutBroken()).toBe(true)
    // Queued writes can emit again after the first break: still swallowed.
    expect(() => stdout.emit('error', epipeError())).not.toThrow()
    expect(() => stdout.emit('error', epipeError())).not.toThrow()
    expect(isSupervisorStdoutBroken()).toBe(true)
    expect(stdout.listenerCount('error')).toBe(1)
  })

  it('still surfaces an unrelated async error after a prior EPIPE', () => {
    const stdout = new EventEmitter()
    ensureSupervisorStdoutGuard(stdout as unknown as NodeJS.WriteStream)

    expect(() => stdout.emit('error', epipeError())).not.toThrow()
    const busy = Object.assign(new Error('boom'), { code: 'ENOSPC' })
    expect(() => stdout.emit('error', busy)).toThrow(busy)
    expect(isSupervisorStdoutBroken()).toBe(true)
    expect(stdout.listenerCount('error')).toBe(1)
  })
})
