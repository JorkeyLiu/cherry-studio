import { describe, expect, it } from 'vitest'

import { parseUiObserveArgs } from './args'

describe('parseUiObserveArgs', () => {
  it('parses --help', () => {
    expect(parseUiObserveArgs(['--help'])).toEqual({ ok: true, command: { kind: 'help' } })
  })

  it('parses -h', () => {
    expect(parseUiObserveArgs(['-h'])).toEqual({ ok: true, command: { kind: 'help' } })
  })

  it('parses --list', () => {
    expect(parseUiObserveArgs(['--list'])).toEqual({ ok: true, command: { kind: 'list' } })
  })

  it('rejects --help combined with other arguments', () => {
    expect(parseUiObserveArgs(['--help', 'app-ready'])).toEqual({
      ok: false,
      error: expect.stringContaining('cannot be combined')
    })
  })

  it('rejects --list combined with other arguments', () => {
    expect(parseUiObserveArgs(['--list', '--timeout-ms', '5000'])).toEqual({
      ok: false,
      error: expect.stringContaining('cannot be combined')
    })
  })

  it('parses a built-in scenario selector', () => {
    expect(parseUiObserveArgs(['app-ready'])).toEqual({
      ok: true,
      command: { kind: 'run', scenario: 'app-ready' }
    })
  })

  it('parses a scenario file path', () => {
    expect(parseUiObserveArgs(['./scenarios/foo.ts'])).toEqual({
      ok: true,
      command: { kind: 'run', scenario: './scenarios/foo.ts' }
    })
  })

  it('parses --output-dir with a separate value', () => {
    expect(parseUiObserveArgs(['app-ready', '--output-dir', '/tmp/obs'])).toEqual({
      ok: true,
      command: { kind: 'run', scenario: 'app-ready', outputDir: '/tmp/obs' }
    })
  })

  it('parses --output-dir with an equals value', () => {
    expect(parseUiObserveArgs(['--output-dir=/tmp/obs', 'app-ready'])).toEqual({
      ok: true,
      command: { kind: 'run', scenario: 'app-ready', outputDir: '/tmp/obs' }
    })
  })

  it('rejects --output-dir without a value', () => {
    expect(parseUiObserveArgs(['app-ready', '--output-dir'])).toEqual({
      ok: false,
      error: expect.stringContaining('--output-dir')
    })
  })

  it('rejects an empty --output-dir= value', () => {
    expect(parseUiObserveArgs(['--output-dir=', 'app-ready'])).toEqual({
      ok: false,
      error: expect.stringContaining('--output-dir')
    })
  })

  it('applies equivalent invalid-value validation to both --output-dir forms', () => {
    // A flag-like value is rejected by the separated form...
    expect(parseUiObserveArgs(['app-ready', '--output-dir', '--timeout-ms'])).toEqual({
      ok: false,
      error: expect.stringContaining('--output-dir')
    })
    // ...and by the equals form with the same error.
    expect(parseUiObserveArgs(['--output-dir=--timeout-ms', 'app-ready'])).toEqual({
      ok: false,
      error: expect.stringContaining('--output-dir')
    })
    // A dash-prefixed directory value is rejected identically both ways.
    expect(parseUiObserveArgs(['app-ready', '--output-dir', '-out'])).toEqual({
      ok: false,
      error: expect.stringContaining('--output-dir')
    })
    expect(parseUiObserveArgs(['--output-dir=-out', 'app-ready'])).toEqual({
      ok: false,
      error: expect.stringContaining('--output-dir')
    })
  })

  it('accepts the same valid directory value through both --output-dir forms', () => {
    expect(parseUiObserveArgs(['app-ready', '--output-dir', '/tmp/obs'])).toEqual({
      ok: true,
      command: { kind: 'run', scenario: 'app-ready', outputDir: '/tmp/obs' }
    })
    expect(parseUiObserveArgs(['--output-dir=/tmp/obs', 'app-ready'])).toEqual({
      ok: true,
      command: { kind: 'run', scenario: 'app-ready', outputDir: '/tmp/obs' }
    })
  })

  it('parses --timeout-ms', () => {
    expect(parseUiObserveArgs(['app-ready', '--timeout-ms', '5000'])).toEqual({
      ok: true,
      command: { kind: 'run', scenario: 'app-ready', timeoutMs: 5000 }
    })
  })

  it('rejects a non-integer --timeout-ms', () => {
    expect(parseUiObserveArgs(['app-ready', '--timeout-ms', 'abc'])).toEqual({
      ok: false,
      error: expect.stringContaining('--timeout-ms')
    })
  })

  it('rejects a zero --timeout-ms', () => {
    expect(parseUiObserveArgs(['app-ready', '--timeout-ms', '0'])).toEqual({
      ok: false,
      error: expect.stringContaining('--timeout-ms')
    })
  })

  it('rejects unknown options', () => {
    expect(parseUiObserveArgs(['app-ready', '--bogus'])).toEqual({
      ok: false,
      error: expect.stringContaining('unknown option')
    })
  })

  it('rejects a missing scenario', () => {
    expect(parseUiObserveArgs([])).toEqual({
      ok: false,
      error: expect.stringContaining('missing scenario')
    })
  })

  it('rejects multiple scenarios', () => {
    expect(parseUiObserveArgs(['app-ready', './scenarios/foo.ts'])).toEqual({
      ok: false,
      error: expect.stringContaining('exactly one scenario')
    })
  })

  it('ignores standalone -- separator tokens anywhere in the argument list', () => {
    expect(parseUiObserveArgs(['--', '--help'])).toEqual({ ok: true, command: { kind: 'help' } })
    expect(parseUiObserveArgs(['--', 'app-ready'])).toEqual({
      ok: true,
      command: { kind: 'run', scenario: 'app-ready' }
    })
    expect(parseUiObserveArgs(['app-ready', '--', '--timeout-ms', '5000'])).toEqual({
      ok: true,
      command: { kind: 'run', scenario: 'app-ready', timeoutMs: 5000 }
    })
  })
})
