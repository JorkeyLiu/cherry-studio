/**
 * LoggerService broken-pipe (EPIPE) behavior at the real Main sink:
 * - a synchronous console EPIPE during dev logging never throws outward;
 * - the Winston file transport still receives the entry;
 * - the broken sink stops, the other sink keeps working;
 * - unrelated console failures propagate exactly as bare Node would;
 * - repeated logging never installs duplicate std-stream guards.
 *
 * Runs against the REAL LoggerService (`vi.unmock('@logger')`) with the
 * repo's standard electron/winston setup mocks; only the dev flag is forced
 * on so the console sink path executes under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('@logger')

vi.mock('../../constant', () => ({
  isDev: true
}))

// Forks-pool interop: the setup mock factories lack an explicit default
// export, which the forks runner rejects; re-register the same shapes with
// explicit default exports for this file.
vi.mock('winston', () => {
  const mocked = {
    createLogger: vi.fn(() => ({
      log: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      level: 'info',
      on: vi.fn(),
      end: vi.fn()
    })),
    format: {
      combine: vi.fn(),
      splat: vi.fn(),
      timestamp: vi.fn(),
      errors: vi.fn(),
      json: vi.fn()
    },
    transports: {
      Console: vi.fn(),
      File: vi.fn()
    }
  }
  return { __esModule: true, default: mocked, ...mocked }
})

vi.mock('winston-daily-rotate-file', () => ({
  __esModule: true,
  default: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    log: vi.fn()
  }))
}))

import winston from 'winston'

import { ensureStdPipeGuards, isStdPipeBroken, resetStdPipeGuardForTests } from '../../utils/stdPipeGuard'
import { loggerService } from '../LoggerService'

function epipeError(): NodeJS.ErrnoException {
  const error = new Error('write EPIPE') as NodeJS.ErrnoException
  error.code = 'EPIPE'
  return error
}

// The Winston logger is created once at LoggerService import time (setup
// mock). Capture the file-transport entry point a single time; per-test
// assertions use relative call counts. Console spies are restored after
// every test so they never leak into other suites.
const createLoggerMock = winston.createLogger as unknown as {
  mock: { results: { value: { log: (...args: unknown[]) => void } }[] }
}
const fileLog = createLoggerMock.mock.results[0]?.value.log
if (typeof fileLog !== 'function') {
  throw new Error('expected the mocked Winston logger instance')
}
// Fresh reads every time: afterEach restoreAllMocks may replace the mock
// bookkeeping arrays, so never hold a `.mock.calls` reference across tests.
function fileLogCallCount(): number {
  return (fileLog as unknown as { mock: { calls: unknown[][] } }).mock.calls.length
}

function lastFileLogLevel(): unknown {
  const calls = (fileLog as unknown as { mock: { calls: unknown[][] } }).mock.calls
  return calls[calls.length - 1]?.[0]
}

beforeEach(() => {
  resetStdPipeGuardForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LoggerService broken stdout pipe', () => {
  it('swallows a stdout EPIPE on info and still writes the file transport', () => {
    const callsBefore = fileLogCallCount()
    const infoSpy = vi.spyOn(console, 'info').mockImplementationOnce(() => {
      throw epipeError()
    })

    expect(() => loggerService.info('still logged')).not.toThrow()
    expect(isStdPipeBroken('stdout')).toBe(true)
    // Durable file logging continued for the same entry.
    expect(fileLogCallCount()).toBe(callsBefore + 1)
    expect(lastFileLogLevel()).toBe('info')

    // The broken sink is skipped from here on, but file logging continues.
    loggerService.info('second entry')
    expect(infoSpy).toHaveBeenCalledTimes(1)
    expect(fileLogCallCount()).toBe(callsBefore + 2)
  })

  it('swallows a stderr EPIPE on error without breaking the stdout sink', () => {
    const callsBefore = fileLogCallCount()
    vi.spyOn(console, 'error').mockImplementationOnce(() => {
      throw epipeError()
    })
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    expect(() => loggerService.error('disk hiccup')).not.toThrow()
    expect(isStdPipeBroken('stderr')).toBe(true)
    expect(isStdPipeBroken('stdout')).toBe(false)
    expect(fileLogCallCount()).toBe(callsBefore + 1)

    loggerService.info('stdout still live')
    expect(infoSpy).toHaveBeenCalled()
  })

  it('rethrows an unrelated console failure and keeps the sink open', () => {
    const busy = Object.assign(new Error('no space left'), { code: 'ENOSPC' })
    vi.spyOn(console, 'info').mockImplementationOnce(() => {
      throw busy
    })

    expect(() => loggerService.info('unlucky')).toThrow(busy)
    expect(isStdPipeBroken('stdout')).toBe(false)

    // Sink still open: a healthy write goes through.
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    loggerService.info('recovered')
    expect(infoSpy).toHaveBeenCalled()
  })

  it('swallows an async stdout EPIPE and rethrows unrelated stream errors', () => {
    ensureStdPipeGuards()
    expect(() => process.stdout.emit('error', epipeError())).not.toThrow()
    expect(isStdPipeBroken('stdout')).toBe(true)

    const busy = Object.assign(new Error('boom'), { code: 'ENOSPC' })
    expect(() => process.stdout.emit('error', busy)).toThrow(busy)
    expect(isStdPipeBroken('stderr')).toBe(false)
  })

  it('never installs duplicate std-stream guards across repeated logging', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const stdoutBefore = process.stdout.listenerCount('error')
    const stderrBefore = process.stderr.listenerCount('error')

    for (let i = 0; i < 10; i++) {
      loggerService.info(`beat ${i}`)
      loggerService.withContext('beat').info(`scoped ${i}`)
    }

    expect(process.stdout.listenerCount('error')).toBe(stdoutBefore)
    expect(process.stderr.listenerCount('error')).toBe(stderrBefore)
  })
})
