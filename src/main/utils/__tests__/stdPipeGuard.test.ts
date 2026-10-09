/**
 * Bounded EPIPE guard semantics (stdout/stderr sinks only):
 * - only `code === 'EPIPE'` is swallowed, sync and async;
 * - the broken sink stops, the other sink keeps working;
 * - unrelated errors propagate exactly as bare writes would;
 * - guard install is idempotent (no duplicate listeners);
 * - the guarded write always lets the caller continue (file logging stays
 *   outside the guard in LoggerService).
 */
import { EventEmitter } from 'node:events'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ensureStdPipeGuards,
  guardStdPipeWrite,
  isBrokenPipeError,
  isStdPipeBroken,
  resetStdPipeGuardForTests
} from '../stdPipeGuard'

function epipeError(): NodeJS.ErrnoException {
  const error = new Error('write EPIPE') as NodeJS.ErrnoException
  error.code = 'EPIPE'
  return error
}

beforeEach(() => {
  resetStdPipeGuardForTests()
})

describe('isBrokenPipeError', () => {
  it('matches only the EPIPE code shape', () => {
    expect(isBrokenPipeError(epipeError())).toBe(true)
    expect(isBrokenPipeError({ code: 'EPIPE' })).toBe(true)
    expect(isBrokenPipeError({ code: 'ENOSPC' })).toBe(false)
    expect(isBrokenPipeError(new Error('boom'))).toBe(false)
    expect(isBrokenPipeError(null)).toBe(false)
    expect(isBrokenPipeError(undefined)).toBe(false)
    expect(isBrokenPipeError('EPIPE')).toBe(false)
  })
})

describe('guardStdPipeWrite (synchronous throw)', () => {
  it('swallows a stdout EPIPE and stops only the stdout sink', () => {
    const stdoutWrite = vi.fn().mockImplementationOnce(() => {
      throw epipeError()
    })
    const stderrWrite = vi.fn()

    expect(() => guardStdPipeWrite('stdout', stdoutWrite)).not.toThrow()
    expect(isStdPipeBroken('stdout')).toBe(true)
    expect(isStdPipeBroken('stderr')).toBe(false)

    // Broken sink is skipped from here on; stderr still writes.
    guardStdPipeWrite('stdout', stdoutWrite)
    expect(stdoutWrite).toHaveBeenCalledTimes(1)
    expect(() => guardStdPipeWrite('stderr', stderrWrite)).not.toThrow()
    expect(stderrWrite).toHaveBeenCalledTimes(1)
  })

  it('swallows a stderr EPIPE independently of stdout', () => {
    const stderrWrite = vi.fn().mockImplementationOnce(() => {
      throw epipeError()
    })
    expect(() => guardStdPipeWrite('stderr', stderrWrite)).not.toThrow()
    expect(isStdPipeBroken('stderr')).toBe(true)
    expect(isStdPipeBroken('stdout')).toBe(false)
  })

  it('rethrows unrelated errors and keeps the sink open', () => {
    const busy = Object.assign(new Error('no space'), { code: 'ENOSPC' })
    const write = vi.fn().mockImplementation(() => {
      throw busy
    })
    expect(() => guardStdPipeWrite('stdout', write)).toThrow(busy)
    expect(isStdPipeBroken('stdout')).toBe(false)
  })

  it('lets the caller continue to durable work after an EPIPE (file log still runs)', () => {
    const fileWrite = vi.fn()
    const consoleWrite = vi.fn().mockImplementationOnce(() => {
      throw epipeError()
    })
    guardStdPipeWrite('stdout', consoleWrite)
    fileWrite('durable entry')
    expect(fileWrite).toHaveBeenCalledWith('durable entry')
  })
})

describe('ensureStdPipeGuards (async stream error)', () => {
  it('swallows an async stdout EPIPE and stops the sink', () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    ensureStdPipeGuards(stdout as unknown as NodeJS.WriteStream, stderr as unknown as NodeJS.WriteStream)

    expect(() => stdout.emit('error', epipeError())).not.toThrow()
    expect(isStdPipeBroken('stdout')).toBe(true)
    expect(isStdPipeBroken('stderr')).toBe(false)
  })

  it('rethrows an unrelated async stream error (Node behavior preserved)', () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    ensureStdPipeGuards(stdout as unknown as NodeJS.WriteStream, stderr as unknown as NodeJS.WriteStream)

    const busy = Object.assign(new Error('boom'), { code: 'ENOSPC' })
    expect(() => stdout.emit('error', busy)).toThrow(busy)
    expect(isStdPipeBroken('stdout')).toBe(false)
  })

  it('installs exactly once across repeated init (no duplicate listeners)', () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    ensureStdPipeGuards(stdout as unknown as NodeJS.WriteStream, stderr as unknown as NodeJS.WriteStream)
    ensureStdPipeGuards(stdout as unknown as NodeJS.WriteStream, stderr as unknown as NodeJS.WriteStream)
    ensureStdPipeGuards(stdout as unknown as NodeJS.WriteStream, stderr as unknown as NodeJS.WriteStream)

    expect(stdout.listenerCount('error')).toBe(1)
    expect(stderr.listenerCount('error')).toBe(1)
  })

  it('handles repeated async EPIPE events on an already-broken sink', () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    ensureStdPipeGuards(stdout as unknown as NodeJS.WriteStream, stderr as unknown as NodeJS.WriteStream)

    expect(() => stdout.emit('error', epipeError())).not.toThrow()
    expect(isStdPipeBroken('stdout')).toBe(true)
    // Queued writes can emit again after the first break: still swallowed,
    // listener stays attached, no leak.
    expect(() => stdout.emit('error', epipeError())).not.toThrow()
    expect(() => stdout.emit('error', epipeError())).not.toThrow()
    expect(isStdPipeBroken('stdout')).toBe(true)
    expect(stdout.listenerCount('error')).toBe(1)
    expect(stderr.listenerCount('error')).toBe(1)
  })

  it('still surfaces an unrelated async error after a prior EPIPE', () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    ensureStdPipeGuards(stdout as unknown as NodeJS.WriteStream, stderr as unknown as NodeJS.WriteStream)

    expect(() => stdout.emit('error', epipeError())).not.toThrow()
    expect(isStdPipeBroken('stdout')).toBe(true)

    const busy = Object.assign(new Error('boom'), { code: 'ENOSPC' })
    expect(() => stdout.emit('error', busy)).toThrow(busy)
    // The EPIPE-broken flag stays set; the unrelated error was not swallowed.
    expect(isStdPipeBroken('stdout')).toBe(true)
    expect(stdout.listenerCount('error')).toBe(1)
  })

  it('keeps async sinks independent across repeated EPIPE events', () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    ensureStdPipeGuards(stdout as unknown as NodeJS.WriteStream, stderr as unknown as NodeJS.WriteStream)

    expect(() => stdout.emit('error', epipeError())).not.toThrow()
    expect(() => stdout.emit('error', epipeError())).not.toThrow()
    expect(isStdPipeBroken('stdout')).toBe(true)
    expect(isStdPipeBroken('stderr')).toBe(false)

    expect(() => stderr.emit('error', epipeError())).not.toThrow()
    expect(isStdPipeBroken('stderr')).toBe(true)
    expect(stdout.listenerCount('error')).toBe(1)
    expect(stderr.listenerCount('error')).toBe(1)
  })
})
