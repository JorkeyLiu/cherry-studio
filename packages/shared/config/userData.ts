/**
 * Pure userData/profile resolution helpers (LOCK-RETIRE-001 / LOCK-PROFILE-006).
 *
 * These helpers are deliberately free of Electron imports so they can be
 * unit-tested without touching a real user profile and reused by the main
 * process bootstrap (`src/main/utils/init.ts`) and the dev suffix logic
 * (`src/main/config.ts`).
 *
 * Cherry Chat is the sole application identity (LOCK-RETIRE-001/002), so the
 * base resolution is a single immutable rule — no flavor branch and no
 * `cherry-studio` fallback.
 *
 * Resolution precedence:
 *   0. explicit `--user-data-dir=<path>` CLI override (Electron applies it to
 *      `app.getPath('userData')` before JS runs; resolution preserves the
 *      user's explicit intent, packaged and dev — see `findExplicitUserDataDir`),
 *   1. identity-specific configured `appDataPath` from
 *      `<homedir>/<homeDirName>/config/config.json` (packaged only),
 *   2. portable `data` directory (packaged only),
 *   3. identity default — the Cherry Chat profile (`<appDataRoot>/Cherry Chat`).
 *
 * The app MUST never resolve to a known Cherry Studio default profile — both
 * the ADR-canonical `<appDataRoot>/Cherry Studio` and the actual
 * Electron/package-derived `<appDataRoot>/CherryStudio` forms are protected
 * (see {@link CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES}); {@link
 * isCherryStudioDefaultUserData} backs the startup refusal guard, which the
 * bootstrap applies AFTER resolution so a CLI override pointing at a Cherry
 * Studio default still fails closed (LOCK-PROFILE-006).
 */
import path from 'node:path'

import { type AppIdentity } from './identity'

export type UserDataSource = 'cli-override' | 'identity-default' | 'configured-path' | 'portable'

export interface ResolveUserDataInput {
  /** Resolved application identity (the single Cherry Chat identity). */
  identity: AppIdentity
  /** `app.getPath('appData')` — platform app-data root (e.g. `~/Library/Application Support`). */
  appDataRoot: string
  /** Identity-specific configured `appDataPath`, or null when not configured. */
  configuredAppDataPath: string | null
  /** Portable `data` directory (`join(PORTABLE_EXECUTABLE_DIR||exe, 'data')`), or null when not portable. */
  portableDataDir: string | null
  /** Explicit `--user-data-dir=<path>` CLI override value, or null when absent. */
  explicitUserDataDir: string | null
  /** Whether the app is packaged (config/portable precedence only applies when packaged). */
  isPackaged: boolean
  /** Whether portable mode is active. */
  isPortable: boolean
}

export interface UserDataResolution {
  /** Resolved userData path (pre-dev-suffix; see {@link applyDevSuffix}). */
  path: string
  /** Which rule produced the resolution. */
  source: UserDataSource
}

/**
 * Find an explicit `--user-data-dir=<path>` override in the Electron main
 * process argv. Returns the exact path value, or null when absent.
 *
 * Only the single exact `=`-joined token form is recognized — the same form
 * Electron applies to `app.getPath('userData')` before JS runs and the form
 * the E2E exact-token process cleanup relies on (`--user-data-dir=<token>`).
 * The first matching token wins; a token with an empty value is ignored.
 */
export function findExplicitUserDataDir(argv: readonly string[]): string | null {
  const prefix = '--user-data-dir='
  for (const arg of argv) {
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length)
      if (value.length > 0) return value
    }
  }
  return null
}

/**
 * Resolve the base userData directory (before the historical dev `Dev`
 * suffix is applied by `src/main/config.ts`).
 */
export function resolveUserDataBase(input: ResolveUserDataInput): UserDataResolution {
  if (input.explicitUserDataDir) {
    // Highest precedence (packaged and dev): Electron already applied
    // `--user-data-dir` to `app.getPath('userData')` before the main script
    // ran. The bootstrap preserves that exact value and only re-applies it
    // defensively if it somehow differs. The LOCK-PROFILE-006 refusal guard
    // still runs on top and fails closed for a Cherry Studio default.
    return { path: input.explicitUserDataDir, source: 'cli-override' }
  }

  if (input.isPackaged) {
    if (input.configuredAppDataPath) {
      return { path: input.configuredAppDataPath, source: 'configured-path' }
    }
    if (input.isPortable && input.portableDataDir) {
      return { path: input.portableDataDir, source: 'portable' }
    }
  }

  // LOCK-RETIRE-001: Cherry Chat derives its profile from its own identity.
  return { path: path.join(input.appDataRoot, input.identity.userDataDirName), source: 'identity-default' }
}

/**
 * Historical dev profile suffix applied by `src/main/config.ts` on top of the
 * resolved base. Single-sourced here so the dev-profile behavior is testable.
 */
export function applyDevSuffix(baseUserData: string, isDev: boolean): string {
  return isDev ? `${baseUserData}Dev` : baseUserData
}

/**
 * Canonical Cherry Studio default profile directory names that the app must
 * never resolve its runtime userData to (LOCK-PROFILE-006). Explicit
 * compatibility list, single-sourced here so the guard, its tests, and the
 * packaged E2E all lock the SAME two names:
 *
 * - `Cherry Studio` — the ADR-canonical form (the Cherry Studio packaged
 *   `productName`).
 * - `CherryStudio` — the ACTUAL profile Electron derives from the packaged
 *   Cherry Studio package.json `name` (`CherryStudio` — verified empirically
 *   on the packaged binary).
 *
 * Both must fail closed.
 */
export const CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES: readonly string[] = ['Cherry Studio', 'CherryStudio']

/**
 * LOCK-PROFILE-006 guard: the app must never resolve its runtime userData to a
 * known Cherry Studio default profile. Returns true when the given userData
 * path equals `<appDataRoot>/<protected-name>` for any name in {@link
 * CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES} (`Cherry Studio` and
 * `CherryStudio`).
 */
export function isCherryStudioDefaultUserData(appDataRoot: string, userDataPath: string): boolean {
  const resolved = path.resolve(userDataPath)
  return CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES.some(
    (profileName) => resolved === path.resolve(path.join(appDataRoot, profileName))
  )
}
