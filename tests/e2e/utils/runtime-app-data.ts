/**
 * Shared runtime appDataPath probe and exact-match assertion.
 *
 * The LOCK-OBS-003 obligation shared by the E2E fixture and the `ui:observe`
 * observation harness: before any localStorage / Redux / IPC mutation, the
 * running app's runtime appDataPath must be proven to be EXACTLY the
 * disposable profile passed via `--user-data-dir`. Any redirect (for example
 * a config.json override pointing at live user data) throws before any step
 * runs.
 *
 * The assertion is a pure function so it is deterministically testable; the
 * probe wraps it with the `getAppInfo()` IPC read used by the fixture.
 */
import type { Page } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

export interface RuntimeAppDataProbe {
  /** The exact runtime appDataPath reported by the app (never a prediction). */
  runtimeAppDataPath: string
  /** chat.db derived from the runtime appDataPath. */
  chatDbPath: string
}

/**
 * Pure exact-match assertion. Throws the canonical LOCK-OBS-003 VIOLATION message
 * when the runtime path is not the expected disposable profile.
 *
 * An explicit `--user-data-dir=<profile>` override is preserved verbatim by
 * src/main/config.ts (no `Dev` suffix), so the runtime appDataPath must equal
 * the expected profile exactly: canonical parent equality plus exact child
 * basename equality (macOS resolves /var → /private/var, so the parent is
 * realpath-normalized).
 */
export function assertRuntimeAppDataMatches(expectedUserDataDir: string, runtimeAppDataPath: string): void {
  const expectedChildName = path.basename(expectedUserDataDir)
  const resolvedTmpdir = fs.realpathSync(path.dirname(expectedUserDataDir))
  const expectedProfilePath = path.join(resolvedTmpdir, expectedChildName)
  const resolvedRuntime = fs.realpathSync(path.dirname(runtimeAppDataPath))
  const runtimeChildName = path.basename(runtimeAppDataPath)
  if (resolvedRuntime !== resolvedTmpdir || runtimeChildName !== expectedChildName) {
    throw new Error(
      `LOCK-OBS-003 VIOLATION: Runtime appDataPath "${runtimeAppDataPath}" ` +
        `(resolved parent: "${resolvedRuntime}", child: "${runtimeChildName}") ` +
        `does not match expected disposable path "${expectedProfilePath}" ` +
        `(resolved parent: "${resolvedTmpdir}", child: "${expectedChildName}"). ` +
        `A config.json override may be redirecting to live data.`
    )
  }
}

/**
 * Probe the running Electron app for its actual runtime userData/appData path
 * via the existing `getAppInfo()` IPC API (test-neutral, no production
 * changes), assert it exactly matches the expected disposable profile, and
 * return the runtime path plus the chat.db path derived from it.
 */
export async function probeAndAssertRuntimeAppData(
  page: Page,
  expectedUserDataDir: string
): Promise<RuntimeAppDataProbe> {
  const info = await page.evaluate(async () => {
    try {
      const api = (window as any).api
      const appInfo = await api.getAppInfo()
      if (!appInfo || typeof appInfo !== 'object') {
        return { ok: false, error: 'getAppInfo() returned non-object' }
      }
      if (!appInfo.appDataPath || typeof appInfo.appDataPath !== 'string') {
        return { ok: false, error: `appDataPath is not a string: ${typeof appInfo.appDataPath}` }
      }
      return { ok: true, appDataPath: appInfo.appDataPath }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  if (!info.ok) {
    throw new Error(`Failed to probe runtime appDataPath: ${info.error}`)
  }

  assertRuntimeAppDataMatches(expectedUserDataDir, info.appDataPath)
  return {
    runtimeAppDataPath: info.appDataPath,
    chatDbPath: path.join(info.appDataPath, 'Data', 'chat.db')
  }
}
