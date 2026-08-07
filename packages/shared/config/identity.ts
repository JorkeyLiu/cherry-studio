/**
 * Centralized application identity configuration.
 *
 * Cherry Chat is the sole application target identity (LOCK-RETIRE-001):
 * productName `Cherry Chat`, appId `com.jorkeyliu.CherryChat`, protocol
 * `cherrychat://`, independent userData/home/temp, updater disabled. The
 * historical dual-flavor machinery (IDENTITY-001 / `VITE_APP_FLAVOR` /
 * `__APP_FLAVOR__`) is retired (LOCK-RETIRE-002): there is no build-time
 * flavor selection and no internal `cherry-studio` target identity anymore.
 * This module is a single immutable constant; plain Node/tsx consumers (scripts,
 * node-only tests) import it directly with no compile-time define.
 *
 * Source-compatibility identifiers consumed by L2 import (Dexie database
 * `CherryStudio`, `persist:cherry-studio`, deep-link formats, …) are
 * deliberately NOT part of this identity. They are contracts that stay
 * unchanged regardless of the target application (LOCK-COMPAT-003).
 */

export interface AppIdentity {
  /** Product name (App-Name identity header, tray/dock naming). */
  productName: string
  /** Bundle / app identifier used for runtime identity (e.g. Windows AppUserModelId fallback). */
  appId: string
  /** URL protocol scheme without trailing `://` (e.g. `cherrychat`). */
  protocolScheme: string
  /** URL protocol scheme including `://`, used for OAuth redirect URIs. */
  protocolUrlScheme: string
  /** Human-readable protocol display name (e.g. Linux `.desktop` `Name=`). */
  protocolDisplayName: string
  /** Home-directory suffix under `os.homedir()` (e.g. `.cherrychat`). */
  homeDirName: string
  /**
   * Directory name of the default userData profile under the platform app-data
   * root (e.g. `Cherry Chat`). Matches what the packaged product name derives,
   * so the app always resolves to its own independent profile without ever
   * touching a Cherry Studio profile (LOCK-PROFILE-006).
   */
  userDataDirName: string
  /**
   * Generic temp-directory base name under the OS temp root (e.g.
   * `CherryChat`). Historical default Cherry Studio value is `CherryStudio`;
   * the BackupManager temp identity uses {@link tempDirName} (`cherry-chat`).
   * The two are deliberately separate contracts (historical generic temp root
   * vs. identity-specific backup temp roots).
   */
  genericTempDirName: string
  /** BackupManager temp-directory base name under the OS temp root (e.g. `cherry-chat`). */
  tempDirName: string
  /** Whether the auto-updater is enabled. Cherry Chat: disabled until an independent feed exists (LOCK-UPDATER-004). */
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

/**
 * The single immutable application identity. Cherry Chat is the only target
 * (LOCK-RETIRE-001); there is no flavor selection and no `cherry-studio`
 * fallback (LOCK-RETIRE-002).
 */
export const appIdentity: AppIdentity = {
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
