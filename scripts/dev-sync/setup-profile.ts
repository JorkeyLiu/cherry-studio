/**
 * Per-profile dev-sync readiness check (`pnpm dev:sync`).
 *
 * The fixture reuses ONE durable adopted pair every run: the app itself owns
 * all persistence (profiles, chat, assets, providers, settings, device auth,
 * channel, cursor, outbox, relay state) exactly like a normal close. This
 * module is DIAGNOSTIC ONLY:
 *
 * - verifies the persisted profile identity FIRST: the runtime
 *   `appDataPath` must equal the exact adopted `--user-data-dir` BEFORE any
 *   claim (fail-closed reuse of the E2E LOCK-OBS-003 helper);
 * - verifies the window runtime is available via the typed production read
 *   surface only (`window.api.getAppInfo`) plus rendered-body readiness.
 *   Works on ANY ordinary app route (home, settings, onboarding, no-topic):
 *   no navigation is forced, no reload is triggered, and no textarea/home
 *   element is required;
 * - performs NO mutation: no language/locale change, no localStorage write,
 *   no Redux dispatch, no settings-seed restore, no onboarding bypass, no
 *   provider/assistant/model configuration, no sync endpoint/configure/
 *   connect, no page snapshot, no credential read. CDP attach is observation
 *   only.
 *
 * First-run onboarding, when present, is shown as-is for the user to
 * complete; readiness reports the window runtime as available without
 * binding to a router route. Sync stays exactly as the user left it in the
 * app: the runner never auto-enables, configures, or connects.
 */

import type { Page } from '@playwright/test'

import { probeAndAssertRuntimeAppData } from '../../tests/e2e/utils/runtime-app-data'

export interface DevSyncProfileSetup {
  /** Adopted session basename (safe label only, used for log lines). */
  sessionId: string
  /** Exact adopted `--user-data-dir` for this profile (identity proof). */
  expectedUserDataDir: string
  label: 'A' | 'B'
}

export interface DevSyncProfileResult {
  label: 'A' | 'B'
  sessionId: string
  /** Verified runtime appDataPath (equals expectedUserDataDir exactly). */
  appDataPath: string
}

interface PageEvaluateFn {
  // Minimal structural contract for the diagnostic probe (real Playwright
  // Page satisfies this; focused tests inject fakes). evaluate reuses the
  // actual Playwright Page typing so the real Page stays assignable.
  evaluate: Page['evaluate']
  url: () => string
}

async function readWindowRuntime(page: PageEvaluateFn): Promise<{ appDataPath: string }> {
  const info = (await page.evaluate(async () => {
    const api = (window as unknown as { api?: { getAppInfo?: () => Promise<unknown> } }).api
    if (!api || typeof api.getAppInfo !== 'function') {
      return { ok: false as const, error: 'window.api.getAppInfo not found' }
    }
    try {
      const appInfo = (await api.getAppInfo()) as { appDataPath?: unknown } | null
      if (!appInfo || typeof appInfo.appDataPath !== 'string' || appInfo.appDataPath.length === 0) {
        return { ok: false as const, error: 'appDataPath is not a non-empty string' }
      }
      const root = document.querySelector('#root') ?? document.body
      if (!root) return { ok: false as const, error: 'rendered body not ready' }
      return { ok: true as const, appDataPath: appInfo.appDataPath }
    } catch (error) {
      return { ok: false as const, error: String((error as Error)?.message ?? error) }
    }
  })) as { ok: boolean; appDataPath?: string; error?: string }
  if (!info.ok || typeof info.appDataPath !== 'string') {
    throw new Error(`[dev-sync] window runtime not ready: ${info.error ?? 'unknown'}`)
  }
  return { appDataPath: info.appDataPath }
}

/**
 * Verify one reachable profile window for the dev-sync fixture. Observation
 * only: asserts the persisted profile identity, then proves the window
 * runtime is available. Returns the verified identity for the terminal
 * summary (safe values only).
 */
export async function setupDevSyncProfile(page: Page, setup: DevSyncProfileSetup): Promise<DevSyncProfileResult> {
  // 1. Persisted-profile identity proof BEFORE any claim.
  const probe = await probeAndAssertRuntimeAppData(page, setup.expectedUserDataDir)

  // 2. Window-runtime readiness on the CURRENT route (no navigation, no
  //    reload, no store/localStorage/IPC mutation of any kind).
  const runtime = await readWindowRuntime(page)
  if (runtime.appDataPath !== probe.runtimeAppDataPath) {
    throw new Error('[dev-sync] refusing profile claim: window runtime identity drifted during readiness')
  }

  return { label: setup.label, sessionId: setup.sessionId, appDataPath: probe.runtimeAppDataPath }
}

/** Safe one-line terminal summary for a verified profile (no secrets exist). */
export function formatProfileSummary(result: DevSyncProfileResult): string {
  return (
    `[dev-sync] profile ${result.label} [${result.sessionId}]: ` +
    `persisted pair verified (runtime identity proven, window ready; settings/sync untouched — app persists as-is)`
  )
}
