/**
 * Focused unit tests for the same-profile relaunch helper's pure launch
 * surface (LOCK-UI4 / LOCK-625).
 *
 * Proves that the launch args/env EXACTLY mirror the shared
 * `electron.fixture.ts` contract:
 * 1. The `--user-data-dir=<profile>` token is the exact single-token argv form
 *    that `process-cleanup.hasExactUserDataDirToken` matches (LOCK-625), with
 *    `--no-sandbox` / `--disable-gpu` preserved.
 * 2. The env redirects `NODE_ENV`, clears `ELECTRON_RUN_AS_NODE`, and points
 *    TMPDIR/TMP/TEMP at the owned temp root so production `os.tmpdir()`
 *    resolves inside the owned root (LOCK-002).
 *
 * Pure Node utility tests (vitest project `e2e-utils`); no Electron is
 * launched — the Electron-launching entry point itself is only exercised by
 * the genuine import E2E spec.
 */
import { describe, expect, it } from 'vitest'

import { relaunchArgs, relaunchEnv } from './restart-electron-profile'

const PROFILE = '/tmp/cherry-e2e-owned-abc/cherry-e2e-profile'
const ROOT = '/tmp/cherry-e2e-owned-abc'

describe('relaunchArgs (LOCK-625 exact token form)', () => {
  it('carries the exact single-token --user-data-dir argv form', () => {
    const args = relaunchArgs(PROFILE)
    expect(args).toEqual(['.', `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu'])
    // The token must match the exact-token matcher used for process ownership.
    expect(args.some((token) => token === `--user-data-dir=${PROFILE}`)).toBe(true)
  })
})

describe('relaunchEnv (LOCK-002 owned-temp redirection)', () => {
  it('redirects NODE_ENV, clears ELECTRON_RUN_AS_NODE, and pins TMPDIR/TMP/TEMP to the owned root', () => {
    const env = relaunchEnv(ROOT)
    expect(env.NODE_ENV).toBe('development')
    expect(env.ELECTRON_RUN_AS_NODE).toBe('')
    expect(env.TMPDIR).toBe(ROOT)
    expect(env.TMP).toBe(ROOT)
    expect(env.TEMP).toBe(ROOT)
  })
})
