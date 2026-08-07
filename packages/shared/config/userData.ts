/**
 * Pure userData/profile resolution helpers (IDENTITY-002 / IDENTITY-006).
 *
 * These helpers are deliberately free of Electron imports so they can be
 * unit-tested without touching a real user profile and reused by the main
 * process bootstrap (`src/main/utils/init.ts`) and the dev suffix logic
 * (`src/main/config.ts`).
 *
 * Resolution precedence:
 *   0. explicit `--user-data-dir=<path>` CLI override (Electron applies it to
 *      `app.getPath('userData')` before JS runs; resolution preserves the
 *      user's explicit intent for BOTH flavors, packaged and dev — see
 *      `findExplicitUserDataDir`),
 *   1. flavor-specific configured `appDataPath` from
 *      `<homedir>/<homeDirName>/config/config.json` (packaged only),
 *   2. portable `data` directory (packaged only),
 *   3. identity default — `Cherry Chat` profile for the `cherry-chat` flavor
 *      (dev and packaged), or Electron's default userData for `cherry-studio`.
 *
 * The `cherry-chat` flavor MUST never resolve to a known Cherry Studio
 * default profile — both the ADR-canonical `<appDataRoot>/Cherry Studio` and
 * the actual Electron/package-derived `<appDataRoot>/CherryStudio` forms are
 * protected (see {@link CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES}); {@link
 * isCherryStudioDefaultUserData} backs the startup refusal guard, which the
 * bootstrap applies AFTER resolution so a CLI override pointing at a Cherry
 * Studio default still fails closed (IDENTITY-006).
 */
import path from 'node:path'

import { type AppIdentity } from './identity'

export type UserDataSource = 'cli-override' | 'identity-default' | 'configured-path' | 'portable' | 'electron-default'

export interface ResolveUserDataInput {
  /** Resolved application identity for the running flavor. */
  identity: AppIdentity
  /** `app.getPath('appData')` — platform app-data root (e.g. `~/Library/Application Support`). */
  appDataRoot: string
  /** Electron's default userData path before any override (used only for the default flavor). */
  electronDefaultUserData: string
  /** Flavor-specific configured `appDataPath`, or null when not configured. */
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
    // Highest precedence (both flavors, packaged and dev): Electron already
    // applied `--user-data-dir` to `app.getPath('userData')` before the main
    // script ran. The bootstrap preserves that exact value and only re-applies
    // it defensively if it somehow differs. The IDENTITY-006 refusal guard
    // still runs on top and fails closed for the Cherry Studio default.
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

  if (input.identity.flavor === 'cherry-chat') {
    // IDENTITY-002: Cherry Chat derives its profile from its own identity.
    return { path: path.join(input.appDataRoot, input.identity.userDataDirName), source: 'identity-default' }
  }

  // IDENTITY-001: the default Cherry Studio build keeps Electron's own
  // derivation (from the packaged product name) byte-for-byte unchanged.
  return { path: input.electronDefaultUserData, source: 'electron-default' }
}

/**
 * Historical dev profile suffix applied by `src/main/config.ts` on top of the
 * resolved base. Single-sourced here so the dev-profile behavior is testable
 * and identical for both flavors.
 */
export function applyDevSuffix(baseUserData: string, isDev: boolean): string {
  return isDev ? `${baseUserData}Dev` : baseUserData
}

/**
 * Canonical Cherry Studio default profile directory names that the
 * `cherry-chat` flavor must never resolve its runtime userData to
 * (IDENTITY-006). Explicit compatibility list, single-sourced here so the
 * guard, its tests, and the packaged E2E all lock the SAME two names:
 *
 * - `Cherry Studio` — the ADR-canonical form (`resolveAppIdentity('cherry-studio')
 *   .userDataDirName` / the packaged `productName`).
 * - `CherryStudio` — the ACTUAL profile Electron derives from the packaged
 *   package.json `name` (`CherryStudio` — verified empirically: the packaged
 *   binary reports `app.getName() === 'CherryStudio'` and the real profile
 *   lives at `<appDataRoot>/CherryStudio`).
 *
 * Both must fail closed for `cherry-chat`; the default flavor is never gated
 * (IDENTITY-001).
 */
export const CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES: readonly string[] = ['Cherry Studio', 'CherryStudio']

/**
 * IDENTITY-006 guard: `cherry-chat` must never resolve its runtime userData to
 * a known Cherry Studio default profile. Returns true when the given userData
 * path equals `<appDataRoot>/<protected-name>` for any name in {@link
 * CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES} (`Cherry Studio` and
 * `CherryStudio`) for the cherry-chat flavor; always false for the default
 * flavor.
 */
export function isCherryStudioDefaultUserData(
  identity: AppIdentity,
  appDataRoot: string,
  userDataPath: string
): boolean {
  if (identity.flavor !== 'cherry-chat') {
    return false
  }
  const resolved = path.resolve(userDataPath)
  return CHERRY_STUDIO_PROTECTED_USER_DATA_NAMES.some(
    (profileName) => resolved === path.resolve(path.join(appDataRoot, profileName))
  )
}
