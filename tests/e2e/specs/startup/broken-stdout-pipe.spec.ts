/**
 * Broken dev-stdout/stderr pipe (EPIPE) runtime contract.
 *
 * Regression: `pnpm dev sync` Ctrl-C could close the dev stdout/stderr pipe
 * while the Electron main process was still logging. The synchronous
 * `console.*` write then threw `write EPIPE` out of
 * `LoggerService.processLog`, surfacing as an uncaught exception (error
 * dialog / crash) even though the durable Winston file transports were
 * unaffected. The production fix bounds EPIPE handling to the std output
 * sinks only: the broken sink is skipped from then on, file logging always
 * continues, and unrelated errors still propagate as bare Node would.
 *
 * - `durable main file logging survives boot on a disposable profile`
 *   (active): standard shared fixture, unique disposable profile, mocked
 *   providers. Proves the file-logging half of the contract
 *   deterministically.
 * - `injected EPIPE error events on std sinks stay handled and the app
 *   remains usable` (active): standard shared fixture, unique disposable
 *   profile, mocked providers. Injects `error` events carrying `code:
 *   'EPIPE'` on the real Electron main `process.stdout`/`process.stderr`
 *   via `electronApp.evaluate` (no actual pipe destruction), repeats each
 *   sink to cover queued writes after the first break, then proves the
 *   main/renderer side remains usable (ChatDb IPC probe) and the central
 *   logger file path still produced durable boot logs. The guard under test
 *   is the one installed at Main startup (`ensureStdPipeGuards` in
 *   `LoggerService`), including production startup.
 *
 * This injection proves EPIPE-event handling in the launched runtime only;
 * it does not reproduce the Ctrl-C supervisor-teardown timing (actual pipe
 * closure under `pnpm dev sync` remains unverified here by design).
 *
 * Uses the shared fixture + ownership contract throughout: unique disposable
 * profile beneath the fixture owned root, exact-token process cleanup, no
 * live data, mock provider only.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { expect, getRuntimeAppDataPath, test } from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'

function mainLogFiles(appDataPath: string): string[] {
  const logsDir = path.join(appDataPath, 'logs')
  if (!fs.existsSync(logsDir)) return []
  return fs.readdirSync(logsDir).filter((file) => file.startsWith('app.') && file.endsWith('.log'))
}

test.describe('broken stdout pipe (EPIPE) lifecycle', () => {
  test('durable main file logging survives boot on a disposable profile', async ({ mainWindow }) => {
    await waitForAppReady(mainWindow)
    const appDataPath = getRuntimeAppDataPath()
    expect(appDataPath).not.toBeNull()
    const files = mainLogFiles(appDataPath as string)
    // The Winston file transports must have produced durable boot logs.
    expect(files.length).toBeGreaterThan(0)
  })

  test('injected EPIPE error events on std sinks stay handled and the app remains usable', async ({
    electronApp,
    mainWindow
  }) => {
    await waitForAppReady(mainWindow)

    // Inject EPIPE-shaped async `error` events on the real Main std sinks.
    // Reaching the next line proves the Main guard swallowed them (an
    // unhandled `error` event would reject this evaluate). Repeated emits
    // cover queued writes after the first break.
    const injected = await electronApp.evaluate(() => {
      const makeEpipe = (): Error & { code?: string } => {
        const error = new Error('write EPIPE') as Error & { code?: string }
        error.code = 'EPIPE'
        return error
      }
      process.stdout.emit('error', makeEpipe())
      process.stderr.emit('error', makeEpipe())
      process.stdout.emit('error', makeEpipe())
      process.stderr.emit('error', makeEpipe())
      return { emitted: 4 }
    })
    expect(injected).toEqual({ emitted: 4 })

    // Main/renderer remains usable: the ChatDb IPC probe still answers.
    const rendererOk = await mainWindow.evaluate(async () => {
      const w = window as unknown as {
        api?: {
          chatDb?: { topicExists?: (args: { topicId: string }) => Promise<{ ok: boolean }> }
        }
      }
      if (!w.api?.chatDb || typeof w.api.chatDb.topicExists !== 'function') return { ok: false }
      try {
        const result = await w.api.chatDb.topicExists({ topicId: '__e2e_epipe_probe__' })
        return { ok: result?.ok === true }
      } catch {
        return { ok: false }
      }
    })
    expect(rendererOk.ok).toBe(true)

    // Central logger file path still works: durable boot logs exist.
    const appDataPath = getRuntimeAppDataPath()
    expect(appDataPath).not.toBeNull()
    expect(mainLogFiles(appDataPath as string).length).toBeGreaterThan(0)
  })
})
