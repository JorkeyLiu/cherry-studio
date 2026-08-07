/**
 * Centralized application identity configuration.
 *
 * Governed by `docs/cherry-chat-application-identity.md` (IDENTITY-001…006).
 * The default `cherry-studio` flavor MUST remain byte-compatible with the
 * existing Cherry Studio build; `cherry-chat` is an explicit build flavor
 * selected via the build-time environment variable `VITE_APP_FLAVOR`.
 *
 * The flavor is injected by `electron.vite.config.ts` as a statically
 * replaceable `__APP_FLAVOR__` constant (Vite `define`) shared by every build
 * target — main, preload, and renderer (see `./buildFlavor`). It is read here
 * with a `typeof` guard so plain Node/tsx consumers (scripts, node-only
 * tests) never throw and safely default to the Cherry Studio identity
 * (IDENTITY-001). Do NOT read the value through `import.meta.env` with dynamic
 * property access: Vite replaces `import.meta` (not the property lookup),
 * which compiled to `const env = {}.env` and always resolved `undefined` in
 * packaged output.
 *
 * Source-compatibility identifiers consumed by L2 import (Dexie database
 * `CherryStudio`, `persist:cherry-studio`, deep-link formats, …) are
 * deliberately NOT part of this identity. They are contracts that stay
 * unchanged regardless of flavor (IDENTITY-003).
 */

export type AppFlavor = 'cherry-studio' | 'cherry-chat'

/** Build-time environment variable that selects the application flavor. */
export const APP_FLAVOR_ENV_VAR = 'VITE_APP_FLAVOR'

export interface AppIdentity {
  /** Resolved build flavor. */
  flavor: AppFlavor
  /** Product name (App-Name identity header, tray/dock naming). */
  productName: string
  /** Bundle / app identifier used for runtime identity (e.g. Windows AppUserModelId fallback). */
  appId: string
  /** URL protocol scheme without trailing `://` (e.g. `cherrystudio`). */
  protocolScheme: string
  /** URL protocol scheme including `://`, used for OAuth redirect URIs. */
  protocolUrlScheme: string
  /** Human-readable protocol display name (e.g. Linux `.desktop` `Name=`). */
  protocolDisplayName: string
  /** Home-directory suffix under `os.homedir()` (e.g. `.cherrystudio`). */
  homeDirName: string
  /**
   * Directory name of the default userData profile under the platform app-data
   * root (e.g. `Cherry Studio`). Matches what Electron derives from the
   * packaged product name, so the Cherry Chat flavor resolves to its own
   * independent profile (IDENTITY-002) without ever touching the Cherry Studio
   * profile.
   */
  userDataDirName: string
  /**
   * Generic temp-directory base name under the OS temp root (e.g.
   * `CherryStudio`). Historical default Cherry Studio value is `CherryStudio`;
   * the BackupManager temp identity uses {@link tempDirName} (`cherry-studio`).
   * The two are deliberately separate contracts (default Cherry Studio
   * byte-compatibility vs. flavor-specific backup temp roots).
   */
  genericTempDirName: string
  /** BackupManager temp-directory base name under the OS temp root (e.g. `cherry-studio`). */
  tempDirName: string
  /** Whether the auto-updater is enabled. Cherry Chat: disabled until an independent feed exists (IDENTITY-004). */
  updaterEnabled: boolean
  /** Analytics channel identity sent to the analytics backend. */
  analyticsChannel: string
  /** Product token embedded in the generated User-Agent string. */
  userAgentProduct: string
  /** Internal OpenAI-compatible API title (served at the API server root / Swagger docs). */
  apiTitle: string
  /** Linux window class/name switch value. */
  linuxClassAndName: string
  /** Product name reported to the crash reporter. */
  crashReporterProductName: string
}

const FLAVOR_IDENTITIES: Record<AppFlavor, AppIdentity> = {
  'cherry-studio': {
    flavor: 'cherry-studio',
    productName: 'Cherry Studio',
    appId: 'com.kangfenmao.CherryStudio',
    protocolScheme: 'cherrystudio',
    protocolUrlScheme: 'cherrystudio://',
    protocolDisplayName: 'Cherry Studio',
    homeDirName: '.cherrystudio',
    userDataDirName: 'Cherry Studio',
    genericTempDirName: 'CherryStudio',
    tempDirName: 'cherry-studio',
    updaterEnabled: true,
    analyticsChannel: 'cherry-studio',
    userAgentProduct: 'CherryStudio',
    apiTitle: 'Cherry Studio API',
    linuxClassAndName: 'CherryStudio',
    crashReporterProductName: 'CherryStudio'
  },
  'cherry-chat': {
    flavor: 'cherry-chat',
    productName: 'Cherry Chat',
    appId: 'com.jorkeyliu.CherryChat',
    protocolScheme: 'cherrychat',
    protocolUrlScheme: 'cherrychat://',
    protocolDisplayName: 'Cherry Chat',
    homeDirName: '.cherrychat',
    userDataDirName: 'Cherry Chat',
    genericTempDirName: 'CherryChat',
    tempDirName: 'cherry-chat',
    updaterEnabled: false,
    analyticsChannel: 'cherry-chat',
    userAgentProduct: 'CherryChat',
    apiTitle: 'Cherry Chat API',
    linuxClassAndName: 'CherryChat',
    crashReporterProductName: 'CherryChat'
  }
}

/**
 * Resolve identity for a flavor token. Unknown, missing, or malformed
 * tokens resolve to the default Cherry Studio identity — the default build
 * is never altered by an unset/invalid flavor variable (IDENTITY-001).
 */
export function resolveAppIdentity(flavor: string | null | undefined): AppIdentity {
  const normalized = (flavor ?? '').trim().toLowerCase()
  if (normalized === 'cherry-chat') {
    return FLAVOR_IDENTITIES['cherry-chat']
  }
  return FLAVOR_IDENTITIES['cherry-studio']
}

/**
 * Compile-time flavor constant injected by `electron.vite.config.ts` via Vite
 * `define` for every build target (main, preload, renderer). Declared but
 * never assigned at runtime: under Vite/esbuild the identifier is textually
 * replaced with the flavor literal (e.g. `"cherry-chat"`); under plain
 * Node/tsx it stays an undeclared global and `typeof` safely reports
 * `"undefined"`.
 */
declare const __APP_FLAVOR__: string | undefined

/**
 * Read the flavor selected at build time.
 *
 * Returns the compile-time `__APP_FLAVOR__` literal when a Vite build
 * injected one; under plain Node/tsx the identifier is not defined, so this
 * falls back to `undefined` and the default Cherry Studio identity applies
 * (IDENTITY-001). The `typeof` guard must stay: a bare reference would throw
 * `ReferenceError` in plain Node.
 */
function readFlavorEnvValue(): string | undefined {
  return typeof __APP_FLAVOR__ === 'string' ? __APP_FLAVOR__ : undefined
}

/** Flavor selected at build time via `VITE_APP_FLAVOR` (defaults to `cherry-studio`). */
export const appFlavor: AppFlavor = resolveAppIdentity(readFlavorEnvValue()).flavor

/** Resolved identity for the current build. */
export const appIdentity: AppIdentity = FLAVOR_IDENTITIES[appFlavor]
