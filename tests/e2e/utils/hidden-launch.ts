/**
 * Default-hidden launch policy for the shared Electron harness.
 *
 * Every Electron app launched through `launchElectronApp` (Playwright E2E
 * fixture, second-profile helpers, and `pnpm ui:observe`) is UNSHOWN by
 * default, so a test run never steals the developer's focus or flashes a
 * window. This is achieved without touching product behavior: the unique
 * disposable profile is seeded with the product's own launch-to-tray setting
 * (`ConfigKeys.LaunchToTray` = `launchToTray`), the same key the shipped
 * settings UI writes. The main `BrowserWindow` is then created with
 * `show: false` and is never shown, exactly as a launch-to-tray start; it still
 * renders and accepts Playwright CDP input because the product window disables
 * background throttling and CDP input does not require OS focus.
 *
 * `CHERRY_E2E_SHOW=1` opts one invocation back into a visible window for manual
 * debugging (`pnpm test:e2e -- --debug`, `pnpm ui:observe`).
 *
 * Safety: only an owned disposable profile (`<ownedTmpRoot>/cherry-e2e-*`) is
 * ever written; a real/live profile path is refused before any write. Existing
 * preseeded keys in the profile's `config.json` are preserved (merge, never
 * overwrite the file wholesale), so other fixture seeding keeps working.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Opt-out env var: set to `1` to launch a visible (debugging) window. */
export const HIDDEN_LAUNCH_SHOW_ENV = 'CHERRY_E2E_SHOW'

/** Every owned disposable profile basename starts with this prefix. */
export const OWNED_PROFILE_PREFIX = 'cherry-e2e-'

/** Product config key (`ConfigManager`'s `ConfigKeys.LaunchToTray`). */
export const LAUNCH_TO_TRAY_CONFIG_KEY = 'launchToTray'

/** Config file name inside the profile (electron-store default). */
const CONFIG_FILE = 'config.json'

/** True when the run should keep windows hidden (default), false when opted out. */
export function isHiddenLaunchRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HIDDEN_LAUNCH_SHOW_ENV] !== '1'
}

/**
 * Seed `launchToTray: true` into a disposable profile before launch, preserving
 * any keys another step already seeded. Returns the merged config object.
 */
export function seedHiddenLaunchProfile(
  userDataDir: string,
  env: NodeJS.ProcessEnv = process.env
): { written: boolean; configFile: string; config: Record<string, unknown> } {
  const configFile = path.join(userDataDir, CONFIG_FILE)
  if (!isHiddenLaunchRequested(env)) {
    return { written: false, configFile, config: {} }
  }
  if (!path.basename(userDataDir).startsWith(OWNED_PROFILE_PREFIX)) {
    throw new Error(
      `hidden launch refused: "${path.basename(userDataDir)}" is not an owned disposable profile (${OWNED_PROFILE_PREFIX}*)`
    )
  }

  let existing: Record<string, unknown> = {}
  if (fs.existsSync(configFile)) {
    const raw = fs.readFileSync(configFile, 'utf8')
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>
    } catch {
      throw new Error(`hidden launch refused: unreadable ${CONFIG_FILE} in the disposable profile`)
    }
  }

  const config = { ...existing, [LAUNCH_TO_TRAY_CONFIG_KEY]: true }
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return { written: true, configFile, config }
}

/**
 * Force the app's dock icon away (macOS) and report every window's visibility.
 * Test-only: never called on a visible run, and never mutates product code.
 */
export async function hideDockAndReadWindowVisibility(
  electronApp: { evaluate: (fn: any) => Promise<any> },
  env: NodeJS.ProcessEnv = process.env
): Promise<Array<{ title: string; visible: boolean }>> {
  if (!isHiddenLaunchRequested(env)) return []
  return electronApp.evaluate(({ app, BrowserWindow }: any) => {
    try {
      app.dock?.hide?.()
    } catch {
      // Non-macOS or already hidden: nothing to do.
    }
    return BrowserWindow.getAllWindows().map((window: any) => ({
      title: window.getTitle(),
      visible: window.isVisible()
    }))
  })
}
