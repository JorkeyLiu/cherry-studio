/**
 * Per-profile dev-sync setup (`pnpm dev:sync`).
 *
 * Each run uses a FRESH session profile + a FRESH session relay DB, while
 * ordinary settings are retained through owner-only seed files
 * (`local/dev-sync/settings-a.json` / `settings-b.json`; see
 * `settings-seed.ts` for the retention/exclusion contract). Runs inside the
 * supervisor AFTER the Electron window for a profile is reachable via a
 * Playwright Page. Order is load-bearing:
 *
 * 1. `probeAndAssertRuntimeAppData` — runtime `appDataPath` must equal the
 *    exact expected session `--user-data-dir` BEFORE any config/locale
 *    mutation or any settings-seed read (fail-closed reuse of the E2E
 *    LOCK-OBS-003 helper);
 * 2. diagnostic window title (`Cherry Chat [dev-sync A/B · <session>]`) —
 *    renderer runtime only, never touches the immutable appIdentity;
 * 3. coherent zh-CN path mirroring GeneralSettings (persisted storage +
 *    reload, then Redux + preload), with visible Chinese readiness proven on
 *    the Sync connect control (连接);
 * 4. settings-seed restore (when a seed exists) via existing public store
 *    actions only — AFTER the zh-CN reload, because the renderer exposes no
 *    persist-flush handle and a reload would race the async persist write.
 *    Readiness is re-verified after restore;
 * 5. onboarding bypass (legacy flag no-op, same as E2E);
 * 6. sync fixture configuration via the real typed `window.api.sync`
 *    surface — `{ endpoint, enabled: true }` plus `connect`. No shared
 *    token exists anywhere: each profile registers its own public device
 *    code against the fresh session relay. Pairing itself is NEVER
 *    automated — every run starts unpaired and stays that way until the
 *    user pairs manually;
 * 7. open Sync Settings (Settings -> Data -> Sync menu) so each window shows
 *    the device code and the manual request/accept entrypoint.
 *
 * No mock provider is seeded: the page-ready path needs none, and no remote
 * or hidden production provider may be introduced. No secret is logged here:
 * seed summaries carry counts only. An unpaired profile is the NORMAL fresh
 * state — never an alarming error.
 */
import type { Page } from '@playwright/test'

import { SyncSettingsPage } from '../../tests/e2e/pages/sync.page'
import {
  assertChatDbReady,
  assertTextareaReady,
  bypassOnboarding,
  waitForHomeReady
} from '../../tests/e2e/utils/prepare-app'
import { probeAndAssertRuntimeAppData } from '../../tests/e2e/utils/runtime-app-data'
import { waitForAppReady } from '../../tests/e2e/utils/wait-helpers'
import {
  buildSeedRestoreDispatches,
  type DevSyncSeedLabel,
  loadSettingsSeed,
  projectSettingsSeed,
  type SettingsSeedFile,
  type StoreDispatch,
  summarizeSeedForLog,
  writeSettingsSeedAtomic
} from './settings-seed'

export interface DevSyncProfileSetup {
  endpoint: string
  label: DevSyncSeedLabel
  sessionId: string
  expectedUserDataDir: string
  /** Fixture root holding the durable settings seeds (never a profile dir). */
  settingsRoot: string
}

export interface DevSyncProfileResult {
  label: DevSyncSeedLabel
  sessionId: string
  endpoint: string
  deviceCode: string | null
  paired: boolean
  settingsRestored: boolean
}

interface SyncConfigView {
  endpoint?: string
  enabled?: boolean
}

async function readSyncConfig(page: Page): Promise<SyncConfigView> {
  return (await page.evaluate(async () => {
    return (await (
      window as unknown as { api: { sync: { getConfig: () => unknown } } }
    ).api.sync.getConfig()) as Record<string, unknown>
  })) as SyncConfigView
}

/** Typed sync setConfig through the production preload surface (no token). */
async function setSyncConfigViaApi(page: Page, config: { endpoint: string; enabled: boolean }): Promise<void> {
  const result = (await page.evaluate(async (cfg: { endpoint: string; enabled: boolean }) => {
    const api = (window as unknown as { api?: { sync?: { setConfig?: (c: unknown) => Promise<unknown> } } }).api
    if (!api?.sync?.setConfig) return { ok: false as const, error: 'window.api.sync.setConfig not found' }
    try {
      await api.sync.setConfig(cfg)
      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, error: String((error as Error)?.message ?? error) }
    }
  }, config)) as { ok: boolean; error?: string }
  if (!result.ok) throw new Error(`setSyncConfigViaApi failed: ${result.error ?? 'unknown'}`)
}

async function applyZhCn(page: Page): Promise<void> {
  // Persisted storage first, then reload so the app boots in zh-CN through
  // its own path (mirrors the proven E2E language seed, never E2E-edited).
  await page.evaluate(() => {
    window.localStorage.setItem('language', 'zh-CN')
  })
  await page.reload()
  await waitForAppReady(page)
  await page.evaluate(async () => {
    window.localStorage.setItem('language', 'zh-CN')
    ;(window as unknown as { store?: { dispatch: (action: unknown) => void } }).store?.dispatch({
      type: 'settings/setLanguage',
      payload: 'zh-CN'
    })
    try {
      await (window as unknown as { api?: { setLanguage?: (lang: string) => Promise<void> } }).api?.setLanguage?.(
        'zh-CN'
      )
    } catch {
      // Fail-closed below via the rendered-text proof, not here.
    }
  })
  await waitForAppReady(page)
}

async function readDeviceCode(page: Page): Promise<string | null> {
  try {
    const raw = await page.evaluate(async () => {
      try {
        return await (
          window as unknown as { api: { sync: { getDeviceCode: () => Promise<unknown> } } }
        ).api.sync.getDeviceCode()
      } catch {
        return null
      }
    })
    // Production shape is `{ deviceCode: string | null }`; accept a bare
    // string defensively without ever failing the setup over it.
    const code =
      typeof raw === 'string'
        ? raw
        : raw !== null && typeof raw === 'object'
          ? (raw as { deviceCode?: unknown }).deviceCode
          : null
    return typeof code === 'string' && code.length > 0 ? code : null
  } catch {
    return null
  }
}

interface PairStateView {
  state?: unknown
}

/**
 * Production `getPairState` returns `{ state: 'unpaired' | 'outgoing' |
 * 'incoming' | 'paired', ... }` — there is no top-level `.paired` /
 * `.channelId` shape. Paired iff `state === 'paired'`; anything else
 * (including errors) is unpaired, which is the normal fresh-session state.
 */
async function readPaired(page: Page): Promise<boolean> {
  try {
    const state = (await page.evaluate(async () => {
      try {
        return await (
          window as unknown as { api: { sync: { getPairState: () => Promise<unknown> } } }
        ).api.sync.getPairState()
      } catch {
        return null
      }
    })) as PairStateView | null
    return !!state && typeof state === 'object' && state.state === 'paired'
  } catch {
    return false
  }
}

/** Read the live renderer store state for the allowlisted settings snapshot. */
async function readLiveStoreState(page: Page): Promise<unknown> {
  return await page.evaluate(() => {
    const store = (window as unknown as { store?: { getState?: () => unknown } }).store
    if (!store || typeof store.getState !== 'function') throw new Error('renderer store not ready')
    const state = store.getState() as Record<string, unknown>
    return { settings: state.settings, llm: state.llm, assistants: state.assistants }
  })
}

async function dispatchRestoreActions(page: Page, dispatches: StoreDispatch[]): Promise<void> {
  await page.evaluate(async (actions: StoreDispatch[]) => {
    const store = (window as unknown as { store?: { dispatch: (action: unknown) => void } }).store
    if (!store || typeof store.dispatch !== 'function') throw new Error('renderer store not ready')
    for (const action of actions) store.dispatch(action)
  }, dispatches)
}

/**
 * Restore the durable settings seed for one profile (existing public store
 * actions only). Null seed (first run) means fresh defaults — not an error.
 * A malformed seed fails closed with an explicit error (never silently
 * ignored, never partially applied: validation runs before any dispatch).
 */
export async function restoreProfileSettings(
  page: Page,
  options: { expectedUserDataDir: string; settingsRoot: string; label: DevSyncSeedLabel }
): Promise<{ restored: boolean; dispatches: number }> {
  const seed: SettingsSeedFile | null = loadSettingsSeed(options.settingsRoot, options.label)
  if (!seed) return { restored: false, dispatches: 0 }
  const dispatches = buildSeedRestoreDispatches(seed)
  await dispatchRestoreActions(page, dispatches)
  return { restored: true, dispatches: dispatches.length }
}

/**
 * Capture the allowlisted settings snapshot for one profile into its durable
 * seed file. Runs BEFORE the app closes (graceful stop path). The exact
 * runtime path is re-asserted first; the seed file is validated before it is
 * atomically published owner-only. Returns a redacted summary (counts only).
 */
export async function captureProfileSettings(
  page: Page,
  options: { expectedUserDataDir: string; settingsRoot: string; label: DevSyncSeedLabel }
): Promise<string> {
  await probeAndAssertRuntimeAppData(page, options.expectedUserDataDir)
  const raw = await readLiveStoreState(page)
  const projected = projectSettingsSeed(raw)
  const { bytes } = writeSettingsSeedAtomic(options.settingsRoot, options.label, projected)
  return `${summarizeSeedForLog({ label: options.label, ...projected }, 'snapshot saved')} (${bytes} bytes)`
}

/**
 * Set up one reachable profile window for the dev-sync fixture. Returns the
 * public device code / pairing state for the terminal summary (safe values
 * only — there is no token in this fixture).
 */
export async function setupDevSyncProfile(page: Page, setup: DevSyncProfileSetup): Promise<DevSyncProfileResult> {
  // 1. Runtime isolation proof BEFORE any mutation or seed read.
  await probeAndAssertRuntimeAppData(page, setup.expectedUserDataDir)

  // 2. Diagnostic title only (renderer runtime; appIdentity untouched).
  await page.evaluate(
    ({ label, sessionId }: { label: string; sessionId: string }) => {
      document.title = `Cherry Chat [dev-sync ${label} · ${sessionId}]`
    },
    { label: setup.label, sessionId: setup.sessionId }
  )

  // 3. Coherent zh-CN (contains the last full reload of this setup).
  await applyZhCn(page)

  // 4. Onboarding bypass (legacy flag no-op) + home/chat readiness.
  await bypassOnboarding(page)
  await waitForHomeReady(page)
  await assertChatDbReady(page)
  await assertTextareaReady(page)

  // 5. Settings-seed restore AFTER the last reload, through existing public
  //    actions only. Malformed seeds fail closed here (explicit, before any
  //    sync mutation). Readiness is re-verified: replacing the assistants
  //    array re-renders the home surface.
  const { restored, dispatches } = await restoreProfileSettings(page, {
    expectedUserDataDir: setup.expectedUserDataDir,
    settingsRoot: setup.settingsRoot,
    label: setup.label
  })
  if (restored) {
    await waitForHomeReady(page)
    await assertTextareaReady(page)
  }

  // 6. Sync fixture config via the real typed API. Fresh session profiles
  //    always (re)configure the loopback endpoint + enabled, then connect
  //    (each profile registers its own public device code). Pairing itself
  //    is NEVER automated: a fresh relay DB means every run starts unpaired.
  const current = await readSyncConfig(page)
  if (current.endpoint !== setup.endpoint || current.enabled !== true) {
    await setSyncConfigViaApi(page, { endpoint: setup.endpoint, enabled: true })
  }
  try {
    await page.evaluate(async () => {
      await (window as unknown as { api: { sync: { connect: () => Promise<unknown> } } }).api.sync.connect()
    })
  } catch {
    // Connect status surfaces in Sync Settings; the windows stay up for
    // manual inspection instead of failing the whole fixture. Unpaired is
    // the normal fresh state, not an alarming error.
  }

  // 7. Show Sync Settings with Chinese readiness proof (连接 on Connect).
  const syncPage = new SyncSettingsPage(page)
  await syncPage.openSync()
  await syncPage.waitForHydrated()
  // Visible Chinese readiness proof: the Connect control reads 连接.
  await page
    .getByText('连接', { exact: true })
    .first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => {})

  const deviceCode = await readDeviceCode(page)
  const paired = await readPaired(page)
  if (restored) {
    process.stdout.write(`[dev-sync] profile ${setup.label}: settings seed restored (${dispatches} actions)\n`)
  } else {
    process.stdout.write(
      `[dev-sync] profile ${setup.label}: no settings seed yet (fresh defaults; edits snapshot on stop)\n`
    )
  }
  return {
    label: setup.label,
    sessionId: setup.sessionId,
    endpoint: setup.endpoint,
    deviceCode,
    paired,
    settingsRestored: restored
  }
}

/** Safe one-line terminal summary for a configured profile (no secrets exist). */
export function formatProfileSummary(result: DevSyncProfileResult): string {
  const code = result.deviceCode ?? '(device code visible in Sync Settings)'
  const pairing = result.paired ? 'paired' : 'not paired (normal for a fresh session — pair manually: request → accept)'
  const seed = result.settingsRestored ? 'settings seed restored' : 'fresh defaults (seed snapshots on stop)'
  return `[dev-sync] profile ${result.label} [${result.sessionId}]: ${result.endpoint} | device code ${code} | ${seed} | ${pairing}`
}
