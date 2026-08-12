/**
 * Pure assertion tests for the shared runtime appDataPath exact-match contract
 * (LOCK-OBS-003). The `runtime-app-data` module imports Playwright type-only, so
 * these run in the `e2e-utils` Vitest project under the Node lane.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createOwnedTmpRoot } from './run-ownership'
import { assertRuntimeAppDataMatches } from './runtime-app-data'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cherry-e2e-runtime-app-data-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('assertRuntimeAppDataMatches', () => {
  it('accepts the exact disposable profile path', () => {
    const root = createOwnedTmpRoot(tempDir())
    const profile = path.join(root, 'cherry-e2e-probe-match')
    fs.mkdirSync(profile)
    expect(() => assertRuntimeAppDataMatches(profile, profile)).not.toThrow()
  })

  it('rejects a different child basename under the same parent', () => {
    const root = createOwnedTmpRoot(tempDir())
    const expected = path.join(root, 'cherry-e2e-probe-expected')
    const runtime = path.join(root, 'cherry-e2e-probe-other')
    fs.mkdirSync(expected)
    fs.mkdirSync(runtime)
    expect(() => assertRuntimeAppDataMatches(expected, runtime)).toThrow(/LOCK-OBS-003 VIOLATION/)
  })

  it('rejects a different parent (config redirect to live data)', () => {
    const root = createOwnedTmpRoot(tempDir())
    const expected = path.join(root, 'cherry-e2e-probe-expected')
    fs.mkdirSync(expected)
    const elsewhere = tempDir()
    const runtime = path.join(elsewhere, 'cherry-e2e-probe-live')
    fs.mkdirSync(runtime)
    expect(() => assertRuntimeAppDataMatches(expected, runtime)).toThrow(/LOCK-OBS-003 VIOLATION/)
  })

  it('the violation message carries both the runtime and expected paths', () => {
    const root = createOwnedTmpRoot(tempDir())
    const expected = path.join(root, 'cherry-e2e-probe-expected')
    const runtime = path.join(root, 'cherry-e2e-probe-other')
    fs.mkdirSync(expected)
    fs.mkdirSync(runtime)
    let message = ''
    try {
      assertRuntimeAppDataMatches(expected, runtime)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain(runtime)
    expect(message).toContain(expected)
    expect(message).toContain('does not match expected disposable path')
  })
})
