/**
 * Catalog startup recovery driver — recovery-only window orchestration
 * (Phase 2 L2 promotion, LOCK-PROMO-7, LOCK-F2).
 *
 * When the startup recovery gate reports `catalogRecoveryRequired`, the app
 * must NOT boot ordinary UI. This driver:
 *
 *   1. creates a minimal recovery-only BrowserWindow that loads the same
 *      renderer entry with `?cherryImportRecovery=1` (the App renders ONLY
 *      the static recovery surface — ordinary application data flows stay
 *      blocked, LOCK-PROMO-7);
 *   2. registers the catalog boundary against that window's main frame;
 *   3. awaits the renderer's authenticated ready signal (bounded) so the
 *      recovery executor NEVER races the handler mount (LOCK-BRIDGE-1);
 *   4. runs the v2 recovery executor to convergence (all-new or all-old);
 *   5. destroys the recovery window so the normal startup flow (chatDb
 *      init + main window) proceeds — packaged mode may alternatively
 *      app.relaunch().
 *
 * LOCK-F2 (bounded retry + terminal repair surface): a SINGLE transient
 * recovery renderer failure (ready timeout, URL load failure, or a catalog
 * request transport failure) is retried once with a FRESH recovery window.
 * The retry budget never exceeds two windows and the journal/protocol/data
 * semantics are untouched (the v2 executor is idempotent and deterministic
 * on the journal — retrying after a transport failure is exactly the
 * protocol's designed behavior). When the retry budget is exhausted, or the
 * failure is non-transient, the driver keeps the recovery window alive,
 * navigates it to the bounded terminal repair surface (i18n text + machine
 * code ONLY — never paths/names/content/IDs), shows it, and returns
 * `terminalSurface: true` so the caller keeps chatDb blocked and does NOT
 * boot ordinary UI.
 *
 * The driver is deliberately thin: window creation, URL resolution, and the
 * reload/relaunch actions are injectable so the decision/execution logic is
 * unit-testable without Electron.
 *
 * Main-only module. Not exposed over IPC/preload/renderer.
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { loggerService } from '@logger'
import { DATA_PATH } from '@main/config'
import type { WebContents } from 'electron'
import { app } from 'electron'

import {
  applyCandidateCatalog,
  awaitCatalogRecoveryReady,
  disposeCatalogRecoveryIpc,
  queryCatalogFacts,
  registerCatalogRecoveryIpc,
  restoreCatalogSnapshot
} from './promotion/catalogApplyIpc'
import type { RecoveryV2CatalogBoundary } from './promotion/recoveryExecutorV2'
import { type RecoveryV2Options, runRecoveryV2 } from './promotion/recoveryExecutorV2'
import { mintRelaunchReceipt, relaunchApp } from './promotion/relaunch'
import { getMainRendererWebContents, reloadMainRenderer, resolveRestartMode } from './promotion/restart'

const logger = loggerService.withContext('chatDbImportCatalogStartupRecovery')

/** Injectable BrowserWindow surface (tests substitute a double). */
export interface RecoveryWindowLike {
  readonly webContents: WebContents
  loadURL(url: string): Promise<void>
  show(): void
  destroy(): void
}

/** Result of {@link runCatalogStartupRecovery}. Never throws. */
export type CatalogStartupRecoveryResult =
  | { readonly ok: true; readonly action: string; readonly restartRequested: boolean }
  | {
      readonly ok: false
      readonly code: string
      readonly safeCode: string | null
      /**
       * LOCK-F2: true when the recovery window was kept alive and shown with
       * the bounded terminal repair surface (i18n text + machine code only).
       * The caller MUST NOT boot ordinary UI nor init chatDb. False when no
       * window could be shown at all (window creation failed outright) — the
       * caller still fails closed.
       */
      readonly terminalSurface: boolean
    }

export interface CatalogStartupRecoveryOptions {
  dataRoot?: string
  /** Recovery window factory (production: BrowserWindow; tests: double). */
  createWindow: () => RecoveryWindowLike
  /**
   * Recovery window URL resolver. Defaults to the established electron-vite
   * pattern (dev server URL when present, packaged `index.html` otherwise)
   * with the recovery query parameter appended (LOCK-CAT-8). Tests inject a
   * deterministic resolver.
   */
  resolveUrl?: () => Promise<string> | string
  /** Live DB surface for the recovery (chatDbService before init). */
  liveDb: { isInitialised(): boolean; closeForPromotion?(authorization: unknown): boolean }
  /** Packaged → relaunch; non-packaged → in-process reload. */
  restart?: RecoveryV2Options['restart']
  /** Injectable primitives forwarded to the v2 recovery executor. */
  primitives?: RecoveryV2Options['primitives']
}

// ---------------------------------------------------------------------------
// Recovery window URL building (LOCK-CAT-8, LOCK-BRIDGE-3, LOCK-F2)
// ---------------------------------------------------------------------------

/**
 * Append the given query parameters to a renderer URL, preserving any
 * existing query/hash and deduplicating the given keys (the naive
 * `base?param` join produced malformed URLs like `?lang=en?cherryImportRecovery=1`
 * when the dev server URL already carried a query). Scheme-bearing URLs
 * (dev server) are joined through the URL API; bare filesystem paths
 * (packaged `index.html`) use safe manual query joining. Pure and
 * deterministic — unit-testable without Electron.
 */
export function appendRecoveryQueryParams(url: string, params: Record<string, string>): string {
  const paramEntries = Object.entries(params)
  if (url.length === 0) {
    return `?${new URLSearchParams(params).toString()}`
  }
  // Split off any existing hash first so the query parameters land before it.
  const hashIndex = url.indexOf('#')
  const hash = hashIndex === -1 ? '' : url.slice(hashIndex)
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex)
  // Scheme-bearing URL (dev server): reconstruct with the URL API so the
  // existing query is preserved, the given keys are deduplicated, and the
  // raw base spelling (no trailing-slash normalization) is kept.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(withoutHash)) {
    const parsed = new URL(withoutHash)
    for (const [key, value] of paramEntries) {
      parsed.searchParams.set(key, value)
    }
    const rawBase = withoutHash.split(/[?#]/)[0]
    return `${rawBase}?${parsed.searchParams.toString()}${hash}`
  }
  // Bare filesystem path (packaged index.html) — manual safe query joining.
  const queryIndex = withoutHash.indexOf('?')
  if (queryIndex === -1) {
    return `${withoutHash}?${new URLSearchParams(params).toString()}${hash}`
  }
  const pathPart = withoutHash.slice(0, queryIndex)
  const existing = new URLSearchParams(withoutHash.slice(queryIndex + 1))
  for (const [key, value] of paramEntries) {
    existing.set(key, value)
  }
  return `${pathPart}?${existing.toString()}${hash}`
}

/**
 * Build the recovery-only window URL: the given renderer base (dev server URL
 * or packaged HTML path) plus the recovery query parameter (LOCK-CAT-8,
 * LOCK-BRIDGE-3). Existing query/hash on the base is preserved and exactly one
 * `cherryImportRecovery=1` parameter is set.
 */
export function buildRecoveryWindowUrl(rendererBaseUrl: string | null | undefined, packagedHtmlPath: string): string {
  const base = rendererBaseUrl ?? packagedHtmlPath
  return appendRecoveryQueryParams(base, { cherryImportRecovery: '1' })
}

/**
 * Build the bounded terminal repair surface URL (LOCK-F2): the recovery query
 * parameter plus the terminal marker and the bounded machine code. Only the
 * bounded code travels on the wire — never paths/names/content/IDs.
 */
export function buildTerminalRecoveryWindowUrl(baseUrl: string, code: string): string {
  return appendRecoveryQueryParams(baseUrl, {
    cherryImportRecovery: '1',
    cherryRecoveryTerminal: '1',
    cherryRecoveryCode: code
  })
}

// ---------------------------------------------------------------------------
// LOCK-F2 bounded retry classification
// ---------------------------------------------------------------------------

/**
 * Executor failure codes whose retryability is decided by their SUB-code: a
 * catalog request transport failure (renderer connection dropped mid-request)
 * is a transient recovery RENDERER failure and justifies one fresh-window
 * retry. Data-level failures (verification mismatch, unreadable artifacts,
 * journal I/O) are terminal — retrying a fresh window cannot change disk
 * truth and must not re-run destructive work.
 */
const TRANSPORT_SENSITIVE_EXECUTOR_CODES: ReadonlySet<string> = new Set([
  'CATALOG_APPLY_FAILED',
  'CATALOG_FACTS_FAILED'
])

/** Executor sub-codes that are renderer-transport transients (LOCK-F2). */
const RETRYABLE_TRANSPORT_SUB_CODES: ReadonlySet<string> = new Set([
  'NO_TARGET',
  'TIMEOUT',
  'RENDERER_FAILED',
  'BOUNDARY_THREW'
])

/** True when an executor failure is a retryable renderer transport failure. */
function isRetryableExecutorFailure(code: string, safeCode: string | null): boolean {
  if (!TRANSPORT_SENSITIVE_EXECUTOR_CODES.has(code)) return false
  return safeCode !== null && RETRYABLE_TRANSPORT_SUB_CODES.has(safeCode)
}

// ---------------------------------------------------------------------------
// Single-attempt orchestration (LOCK-F2: one attempt = one recovery window)
// ---------------------------------------------------------------------------

/**
 * Outcome of ONE recovery-window attempt. The window is NEVER destroyed by
 * the attempt — the caller owns every window (destroy on success/retry, keep
 * alive + show on terminal) so the terminal repair surface can reuse the
 * final window (LOCK-F2).
 */
type RecoveryAttempt =
  | {
      readonly kind: 'ok'
      readonly action: string
      readonly restartRequested: boolean
      readonly window: RecoveryWindowLike
    }
  | {
      readonly kind: 'transient' | 'terminal'
      readonly code: string
      readonly safeCode: string | null
      readonly window: RecoveryWindowLike
      readonly baseUrl: string
    }
  | { readonly kind: 'window-unavailable'; readonly code: 'WINDOW_CREATE_FAILED' }

/**
 * Run the recovery once against a single recovery window. Never throws — every
 * failure maps to a bounded outcome. The window is left alive for the caller;
 * the catalog boundary IPC never outlives the attempt (LOCK-BRIDGE-1).
 */
async function attemptCatalogRecoveryOnce(options: CatalogStartupRecoveryOptions): Promise<RecoveryAttempt> {
  let window: RecoveryWindowLike
  try {
    window = options.createWindow()
  } catch (error) {
    logger.error('Catalog startup recovery: failed to create the recovery-only window', error as Error)
    return { kind: 'window-unavailable', code: 'WINDOW_CREATE_FAILED' }
  }

  let baseUrl = ''
  try {
    // Register the catalog boundary against the recovery window main frame.
    registerCatalogRecoveryIpc(window.webContents)

    const resolveUrl = options.resolveUrl ?? resolveRecoveryWindowUrl
    try {
      baseUrl = await resolveUrl()
    } catch (error) {
      logger.error('Catalog startup recovery: recovery window URL resolution failed', error as Error)
      return { kind: 'terminal', code: 'UNEXPECTED', safeCode: null, window, baseUrl }
    }
    try {
      await window.loadURL(baseUrl)
    } catch (error) {
      // LOCK-F2: a URL load failure is a transient recovery RENDERER failure —
      // one fresh-window retry is allowed.
      logger.warn(
        'Catalog startup recovery: recovery window load failed (transient — one fresh-window retry allowed)',
        error as Error
      )
      return { kind: 'transient', code: 'LOAD_FAILED', safeCode: null, window, baseUrl }
    }

    // LOCK-BRIDGE-1: the renderer mounts its catalog handler only after
    // PersistGate (App mount), so Main MUST NOT send requests the instant
    // the URL loads — they would race the handler and burn the full 60s
    // per-request timeout. Await the authenticated ready signal (bounded)
    // before invoking the v2 recovery executor.
    const ready = await awaitCatalogRecoveryReady()
    if (!ready.ok) {
      const code = ready.code === 'READY_TIMEOUT' ? 'READY_TIMEOUT' : 'READY_FAILED'
      logger.warn(`Catalog startup recovery: renderer catalog handler not ready (${code})`)
      return { kind: 'transient', code, safeCode: null, window, baseUrl }
    }

    const boundary = createBoundaryFromCatalogApplyIpc()
    const restart = options.restart ?? defaultRestart()

    const result = await runRecoveryV2({
      dataRoot: options.dataRoot ?? DATA_PATH,
      catalogBoundary: boundary,
      liveDb: options.liveDb,
      primitives: options.primitives,
      restart
    })

    if (!result.ok) {
      if (isRetryableExecutorFailure(result.code, result.safeCode)) {
        // LOCK-F2: the renderer connection dropped mid-request — transient.
        logger.warn(
          `Catalog startup recovery: transient executor failure (${result.code}/${String(result.safeCode)}) — ` +
            'one fresh-window retry allowed'
        )
        return { kind: 'transient', code: result.code, safeCode: result.safeCode, window, baseUrl }
      }
      logger.warn(`Catalog startup recovery failed (${result.code}): ${result.safeCode ?? 'no sub-code'}`)
      return { kind: 'terminal', code: result.code, safeCode: result.safeCode, window, baseUrl }
    }
    if (result.deferredToWindow) {
      logger.error('Catalog startup recovery: recovery deferred again (boundary unavailable)')
      return { kind: 'terminal', code: 'DEFERRED_AGAIN', safeCode: null, window, baseUrl }
    }
    logger.info(
      `Catalog startup recovery converged: action=${result.action}, restartRequested=${result.restartRequested}`
    )
    return { kind: 'ok', action: result.action, restartRequested: result.restartRequested, window }
  } catch (error) {
    logger.error('Catalog startup recovery failed unexpectedly', error as Error)
    return { kind: 'terminal', code: 'UNEXPECTED', safeCode: null, window, baseUrl }
  } finally {
    // The boundary never outlives one attempt — the next attempt (or the
    // terminal repair surface) must not see a stale target (LOCK-BRIDGE-1).
    disposeCatalogRecoveryIpc()
  }
}

/**
 * Run the catalog recovery to convergence through a recovery-only window.
 * On success the recovery window is destroyed (or the process relaunched in
 * packaged mode) and ordinary startup may proceed.
 *
 * LOCK-F2: at most ONE fresh recovery-window recreation for a transient
 * READY/load/request renderer failure. On final failure the last window is
 * navigated to the bounded terminal repair surface, shown, and kept alive —
 * the caller must not boot ordinary UI nor init chatDb.
 */
export async function runCatalogStartupRecovery(
  options: CatalogStartupRecoveryOptions
): Promise<CatalogStartupRecoveryResult> {
  const first = await attemptCatalogRecoveryOnce(options)
  if (first.kind === 'ok') {
    destroyRecoveryWindow(first.window)
    return { ok: true, action: first.action, restartRequested: first.restartRequested }
  }
  if (first.kind === 'window-unavailable') {
    // Window creation is itself a fresh-window recreation — bounded retry.
    const second = await attemptCatalogRecoveryOnce(options)
    if (second.kind === 'ok') {
      destroyRecoveryWindow(second.window)
      return { ok: true, action: second.action, restartRequested: second.restartRequested }
    }
    if (second.kind === 'window-unavailable') {
      return { ok: false, code: 'WINDOW_CREATE_FAILED', safeCode: null, terminalSurface: false }
    }
    return showTerminalRepairSurface(second)
  }
  if (first.kind === 'terminal') {
    return showTerminalRepairSurface(first)
  }
  // First attempt was transient — owned cleanup of the failed window, then
  // ONE fresh recovery-window recreation (LOCK-F2 retry budget).
  logger.warn(`Catalog startup recovery: transient failure (${first.code}) — retrying with a fresh recovery window`)
  destroyRecoveryWindow(first.window)
  const second = await attemptCatalogRecoveryOnce(options)
  if (second.kind === 'ok') {
    destroyRecoveryWindow(second.window)
    return { ok: true, action: second.action, restartRequested: second.restartRequested }
  }
  if (second.kind === 'window-unavailable') {
    return { ok: false, code: 'WINDOW_CREATE_FAILED', safeCode: null, terminalSurface: false }
  }
  // Second attempt transient or terminal — the retry budget is exhausted.
  return showTerminalRepairSurface(second)
}

/**
 * LOCK-F2 terminal repair surface: keep the surviving recovery window alive,
 * navigate it to the bounded terminal URL (i18n text + machine code only —
 * the executor sub-code is deliberately NOT forwarded to the renderer), and
 * show it. The caller keeps chatDb blocked and must not boot ordinary UI.
 */
async function showTerminalRepairSurface(
  attempt: Extract<RecoveryAttempt, { kind: 'transient' | 'terminal' }>
): Promise<CatalogStartupRecoveryResult> {
  if (attempt.baseUrl.length > 0) {
    const terminalUrl = buildTerminalRecoveryWindowUrl(attempt.baseUrl, attempt.code)
    try {
      await attempt.window.loadURL(terminalUrl)
    } catch (error) {
      logger.warn(
        'Catalog startup recovery: terminal repair surface navigation failed (window still shown)',
        error as Error
      )
    }
  }
  try {
    attempt.window.show()
  } catch (error) {
    logger.warn('Catalog startup recovery: failed to show the terminal repair surface', error as Error)
  }
  return { ok: false, code: attempt.code, safeCode: null, terminalSurface: true }
}

/** Best-effort destruction of a recovery window (owned cleanup, LOCK-F2). */
function destroyRecoveryWindow(window: RecoveryWindowLike): void {
  try {
    window.destroy()
  } catch {
    // Best-effort — the window may already be gone (relaunch path).
  }
}

/**
 * Production recovery window URL resolution — mirrors the main window content
 * resolution (WindowService): the dev server URL when running unpackaged with
 * `ELECTRON_RENDERER_URL`, the packaged `index.html` otherwise, with the
 * recovery query parameter appended (LOCK-CAT-8). The packaged form is a
 * proper `file://` URL so `webContents.loadURL` accepts it. Tests inject a
 * deterministic resolver via {@link CatalogStartupRecoveryOptions.resolveUrl}.
 */
async function resolveRecoveryWindowUrl(): Promise<string> {
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    return buildRecoveryWindowUrl(process.env['ELECTRON_RENDERER_URL'], '')
  }
  const packagedHtmlUrl = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href
  return buildRecoveryWindowUrl(null, packagedHtmlUrl)
}

/** Production boundary bound to the registered recovery window. */
function createBoundaryFromCatalogApplyIpc(): RecoveryV2CatalogBoundary {
  return {
    applyCandidate: applyCandidateCatalog,
    restoreSnapshot: restoreCatalogSnapshot,
    queryFacts: queryCatalogFacts
  }
}

/** Default restart strategy resolved from `app.isPackaged`. */
function defaultRestart(): RecoveryV2Options['restart'] {
  const mode = resolveRestartMode(app)
  if (mode === 'relaunch') {
    return {
      mode: 'relaunch',
      relaunch: () => {
        const result = relaunchApp(mintRelaunchReceipt('catalog-startup-recovery'))
        return { relaunched: result.ok && result.relaunched }
      }
    }
  }
  return {
    mode: 'in-process-reload',
    relaunch: () => ({ relaunched: false }),
    reloadRenderer: (ownerId: string) => reloadMainRenderer(getMainRendererWebContents(), ownerId)
  }
}
