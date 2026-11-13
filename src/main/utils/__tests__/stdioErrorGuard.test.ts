import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import { installStdioBrokenPipeGuard } from '../stdioErrorGuard'

const asStream = (emitter: EventEmitter) =>
  emitter as unknown as Parameters<typeof installStdioBrokenPipeGuard>[number][number]

const epipe = (): NodeJS.ErrnoException => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })

describe('installStdioBrokenPipeGuard', () => {
  it('absorbs an EPIPE instead of letting it become an uncaught exception', () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const guard = installStdioBrokenPipeGuard([asStream(stdout), asStream(stderr)])

    expect(guard.isBroken()).toBe(false)
    expect(() => stdout.emit('error', epipe())).not.toThrow()
    expect(guard.isBroken()).toBe(true)
  })

  it('keeps every non-EPIPE stream error propagating unchanged', () => {
    const stdout = new EventEmitter()
    const guard = installStdioBrokenPipeGuard([asStream(stdout)])
    const failure = Object.assign(new Error('write EIO'), { code: 'EIO' })

    // The listener rethrows, so the real failure is not swallowed and keeps its
    // identity/message instead of being re-worded.
    expect(() => stdout.emit('error', failure)).toThrow(failure)
    expect(guard.isBroken()).toBe(false)
  })

  it('does not mark the guard broken for a non-pipe stream error', () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const guard = installStdioBrokenPipeGuard([asStream(stdout), asStream(stderr)])
    const failure = new Error('unknown stream failure')

    expect(() => stderr.emit('error', failure)).toThrow(failure)
    expect(guard.isBroken()).toBe(false)
  })
})
