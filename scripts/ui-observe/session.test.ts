/**
 * Session runner result tests for `pnpm ui:observe` (`runObservationSession`).
 *
 * Heavy Electron/E2E dependencies are mocked at the module boundary so these
 * tests never launch Electron: they prove the trusted runtime verification
 * contract — scenario rejection yields `ok: false` with the original error
 * retained, success stays `ok: true`, a bounded timeout keeps a truly pending
 * body `scenarioPending: true`, a settled failure is never pending, and the
 * exact owned cleanup still runs in `finally` without an unhandled rejection.
 *
 * CLI exit behavior (`0` pass / `1` fail / explicit exit only on pending)
 * remains covered by the existing `cli.test.ts` via the injected session
 * runner; these tests supply the `ObservationRunResult` semantics that seam
 * consumes.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMockServer, stopMockServer } from '../../tests/e2e/fixtures/mock-openai-server'
import { closeElectronWithExactCleanup } from '../../tests/e2e/utils/electron-cleanup'
import {
  assertChatDbReady,
  assertTextareaReady,
  bypassOnboarding,
  launchElectronApp,
  seedMockProvider,
  waitForHomeReady,
  waitForMainElectronWindow
} from '../../tests/e2e/utils/prepare-app'
import { createOwnedTmpRoot, removeOwnedTmpRoot, validateProfileLaunchToken } from '../../tests/e2e/utils/run-ownership'
import { probeAndAssertRuntimeAppData } from '../../tests/e2e/utils/runtime-app-data'
import type { ObservationScenario } from './scenario'
import { runObservationSession } from './session'

vi.mock('../../tests/e2e/fixtures/mock-openai-server', () => ({
  createMockServer: vi.fn(),
  stopMockServer: vi.fn()
}))

vi.mock('../../tests/e2e/utils/electron-cleanup', () => ({
  closeElectronWithExactCleanup: vi.fn()
}))

vi.mock('../../tests/e2e/utils/prepare-app', () => ({
  launchElectronApp: vi.fn(),
  waitForMainElectronWindow: vi.fn(),
  bypassOnboarding: vi.fn(),
  seedMockProvider: vi.fn(),
  waitForHomeReady: vi.fn(),
  assertChatDbReady: vi.fn(),
  assertTextareaReady: vi.fn()
}))

vi.mock('../../tests/e2e/utils/process-cleanup', () => ({
  findProcessesByUserDataDir: vi.fn(() => []),
  terminateProcessesByUserDataDir: vi.fn(async () => ({ terminated: [], skipped: [], errors: [] }))
}))

vi.mock('../../tests/e2e/utils/run-ownership', () => ({
  createOwnedTmpRoot: vi.fn(),
  validateProfileLaunchToken: vi.fn(),
  removeOwnedTmpRoot: vi.fn()
}))

vi.mock('../../tests/e2e/utils/runtime-app-data', () => ({
  probeAndAssertRuntimeAppData: vi.fn()
}))

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

function installDefaultMocks(): void {
  const ownedRoot = tempDir('ui-observe-owned-')
  vi.mocked(createOwnedTmpRoot).mockImplementation(() => ownedRoot)
  vi.mocked(validateProfileLaunchToken).mockImplementation((_root: string, profileDir: string) => {
    fs.mkdirSync(profileDir, { recursive: true })
    return profileDir
  })
  vi.mocked(removeOwnedTmpRoot).mockImplementation(async (root: string) => {
    fs.rmSync(root, { recursive: true, force: true })
  })
  vi.mocked(createMockServer).mockResolvedValue({ port: 1 })
  vi.mocked(stopMockServer).mockReturnValue(undefined)

  const fakePage = { screenshot: vi.fn(async () => undefined) }
  const fakeApp = { close: vi.fn(async () => undefined) }
  vi.mocked(launchElectronApp).mockResolvedValue(fakeApp as never)
  vi.mocked(waitForMainElectronWindow).mockResolvedValue(fakePage as never)
  vi.mocked(bypassOnboarding).mockResolvedValue(undefined)
  vi.mocked(seedMockProvider).mockResolvedValue(undefined)
  vi.mocked(waitForHomeReady).mockResolvedValue(undefined)
  vi.mocked(assertChatDbReady).mockResolvedValue(undefined)
  vi.mocked(assertTextareaReady).mockResolvedValue(undefined)
  vi.mocked(probeAndAssertRuntimeAppData).mockImplementation(
    async (_page: Parameters<typeof probeAndAssertRuntimeAppData>[0], expected: string) => ({
      runtimeAppDataPath: expected,
      chatDbPath: path.join(expected, 'Data', 'chat.db')
    })
  )
  vi.mocked(closeElectronWithExactCleanup).mockImplementation(
    async (_dir: string, deps: { close: () => Promise<void> }) => {
      await deps.close()
    }
  )
}

function sessionOptions(scenario: ObservationScenario, timeoutMs?: number) {
  return {
    scenario,
    scenarioSource: 'test:session',
    outputDir: path.join(tempDir('ui-observe-out-'), 'run'),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    log: () => undefined
  }
}

describe('runObservationSession result contract', () => {
  beforeEach(() => {
    installDefaultMocks()
  })

  it('reports ok on scenario success with no pending body', async () => {
    const scenario: ObservationScenario = { name: 'ok', run: async () => undefined }

    const result = await runObservationSession(sessionOptions(scenario))

    expect(result.ok).toBe(true)
    expect(result.error).toBeNull()
    expect(result.cleanupError).toBeNull()
    expect(result.scenarioPending).toBe(false)
    expect(vi.mocked(closeElectronWithExactCleanup)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(stopMockServer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(removeOwnedTmpRoot)).toHaveBeenCalledTimes(1)
  })

  it('preserves an async scenario rejection as failure and still cleans up exactly owned resources', async () => {
    const scenario: ObservationScenario = {
      name: 'async-fail',
      run: async () => {
        throw new Error('async boom')
      }
    }

    const result = await runObservationSession(sessionOptions(scenario))

    expect(result.ok).toBe(false)
    expect(result.error).toBe('async boom')
    expect(result.scenarioPending).toBe(false)
    expect(vi.mocked(closeElectronWithExactCleanup)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(stopMockServer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(removeOwnedTmpRoot)).toHaveBeenCalledTimes(1)
  })

  it('preserves a sync scenario throw as settled failure (never pending) with cleanup', async () => {
    const scenario: ObservationScenario = {
      name: 'sync-fail',
      run: () => {
        throw new Error('sync boom')
      }
    }

    const result = await runObservationSession(sessionOptions(scenario))

    expect(result.ok).toBe(false)
    expect(result.error).toBe('sync boom')
    expect(result.scenarioPending).toBe(false)
    expect(vi.mocked(closeElectronWithExactCleanup)).toHaveBeenCalledTimes(1)
  })

  it('marks a never-settling body as pending after the bounded timeout while cleanup still runs', async () => {
    const scenario: ObservationScenario = {
      name: 'never-settles',
      run: () => new Promise<void>(() => undefined)
    }

    const result = await runObservationSession(sessionOptions(scenario, 20))

    expect(result.ok).toBe(false)
    expect(result.error).toContain('timed out after 20ms')
    expect(result.scenarioPending).toBe(true)
    expect(vi.mocked(closeElectronWithExactCleanup)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(stopMockServer)).toHaveBeenCalledTimes(1)
  })

  it('marks a body that settles during cleanup as no longer pending but keeps the timeout failure', async () => {
    const scenario: ObservationScenario = {
      name: 'settles-after-timeout',
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }

    const result = await runObservationSession(sessionOptions(scenario, 20))

    expect(result.ok).toBe(false)
    expect(result.error).toContain('timed out after 20ms')
    // The body settled during the post-close settle window, so it cannot hang
    // the CLI even though the bounded wait already failed.
    expect(result.scenarioPending).toBe(false)
    expect(vi.mocked(closeElectronWithExactCleanup)).toHaveBeenCalledTimes(1)
  })
})
