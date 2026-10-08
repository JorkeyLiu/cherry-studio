import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { PROBE_KILL_SIGNAL, PROBE_TIMEOUT_MS } from '../constants'
import { createEffects, PROBE_PATH, spawnNodeProbe } from '../effects'

/**
 * Probe emission-contract coverage via REAL subprocess spawns
 * (scripts/native-runtime/probe.cjs):
 *
 *  - the real probe under plain Node reports ok/sqlOk with the marker line;
 *  - the explicit test seam covers the failure contract (sqlOk=false with a
 *    wrong row, thrown load error, close error) — close always in `finally`,
 *    errors preserved, nonzero exit on failure;
 *  - production mode ignores the stub module env without the seam gate.
 *
 * Temp stub modules live under the test-owned os.tmpdir() root and are
 * removed afterwards; the real binary and user databases are never touched
 * (probes use `:memory:` only).
 */

const MARKER = 'NATIVE_RUNTIME_PROBE_V1'

function writeStub(dir: string, name: string, body: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body)
  return file
}

function stubOkWrongRow(): string {
  return `'use strict'\nmodule.exports = function WrongRow() { this.prepare = () => ({ get: () => ({ ok: 2 }) }); this.close = () => {} }\n`
}

function stubThrow(): string {
  return `'use strict'\nthrow new Error('stub load boom')\n`
}

function stubCloseError(): string {
  return `'use strict'\nmodule.exports = function CloseBoom() { this.prepare = () => ({ get: () => ({ ok: 1 }) }); this.close = () => { throw new Error('stub close boom') } }\n`
}

function runProbeWithEnv(extraEnv: NodeJS.ProcessEnv): { status: number | null; stdout: string } {
  const res = spawnSync(process.execPath, [PROBE_PATH], {
    encoding: 'utf8',
    env: { ...process.env, NATIVE_RUNTIME_PROBE_MARKER: MARKER, ...extraEnv },
    timeout: PROBE_TIMEOUT_MS,
    killSignal: PROBE_KILL_SIGNAL
  })
  return { status: res.status, stdout: res.stdout ?? '' }
}

describe('probe.cjs emission contract (real subprocess)', () => {
  it('real Node probe reports ok with a marker line and exit 0', () => {
    const result = spawnNodeProbe(PROBE_PATH)
    expect(result.ok).toBe(true)
    expect(result.sqlOk).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.raw).toContain(`${MARKER} `)
  })

  it('wrong-row stub emits ok:false/sqlOk:false with nonzero exit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-runtime-probe-'))
    try {
      const stub = writeStub(dir, 'wrong-row.cjs', stubOkWrongRow())
      const { status, stdout } = runProbeWithEnv({
        NATIVE_RUNTIME_PROBE_TEST_SEAM: '1',
        NATIVE_RUNTIME_PROBE_MODULE: stub
      })
      expect(status).not.toBe(0)
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith(`${MARKER} `))
      expect(line).toBeDefined()
      const record = JSON.parse(line!.slice(MARKER.length).trim()) as { ok: boolean; sqlOk: boolean; error?: string }
      expect(record.ok).toBe(false)
      expect(record.sqlOk).toBe(false)
      expect(record.error).toBeDefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throwing stub preserves the primary error with nonzero exit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-runtime-probe-'))
    try {
      const stub = writeStub(dir, 'throw.cjs', stubThrow())
      const { status, stdout } = runProbeWithEnv({
        NATIVE_RUNTIME_PROBE_TEST_SEAM: '1',
        NATIVE_RUNTIME_PROBE_MODULE: stub
      })
      expect(status).not.toBe(0)
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith(`${MARKER} `))
      const record = JSON.parse(line!.slice(MARKER.length).trim()) as { ok: boolean; error?: string }
      expect(record.ok).toBe(false)
      expect(record.error).toContain('stub load boom')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('close-error stub preserves the close error with nonzero exit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-runtime-probe-'))
    try {
      const stub = writeStub(dir, 'close.cjs', stubCloseError())
      const { status, stdout } = runProbeWithEnv({
        NATIVE_RUNTIME_PROBE_TEST_SEAM: '1',
        NATIVE_RUNTIME_PROBE_MODULE: stub
      })
      expect(status).not.toBe(0)
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith(`${MARKER} `))
      const record = JSON.parse(line!.slice(MARKER.length).trim()) as {
        ok: boolean
        sqlOk: boolean
        closeError?: string
      }
      expect(record.ok).toBe(false)
      expect(record.sqlOk).toBe(true)
      expect(record.closeError).toContain('stub close boom')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('production mode ignores the stub module without the seam gate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-runtime-probe-'))
    try {
      const stub = writeStub(dir, 'throw.cjs', stubThrow())
      // No NATIVE_RUNTIME_PROBE_TEST_SEAM: the probe must load the real binary.
      const { status } = runProbeWithEnv({ NATIVE_RUNTIME_PROBE_MODULE: stub })
      expect(status).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('createEffects().probeNodeBinding proves real SQL in-process', () => {
    const probe = createEffects().probeNodeBinding()
    expect(probe.ok).toBe(true)
    expect(probe.sqlOk).toBe(true)
  })
})
