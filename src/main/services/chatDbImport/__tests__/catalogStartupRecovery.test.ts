/**
 * catalogStartupRecovery — recovery-only window driver tests
 * (LOCK-CAT-2/8/9, LOCK-BRIDGE-1/3, LOCK-F2).
 *
 * Covers:
 * - Recovery window URL building: dev-server and packaged forms, always with
 *   the `cherryImportRecovery=1` query parameter (LOCK-CAT-8), and the
 *   bounded terminal repair surface URL (LOCK-F2: i18n text + machine code
 *   only).
 * - Driver orchestration: register the catalog boundary against the recovery
 *   window main frame, load the URL, run the v2 recovery to convergence,
 *   dispose the boundary and destroy the window on every exit path.
 * - LOCK-F2 bounded retry: ONE fresh recovery-window recreation for a
 *   transient READY/load/request renderer failure (ready timeout, load
 *   failure, catalog request transport failure). First-fail-second-success
 *   converges; double failure (or any non-transient failure) shows the
 *   bounded terminal repair surface on the surviving window and returns
 *   `terminalSurface: true`.
 * - Owned window cleanup: the failed first window is destroyed before the
 *   fresh recreation; the final window is destroyed on success; the terminal
 *   window is shown and kept alive.
 * - Result mapping: success (in-process), relaunch-pending, failure,
 *   deferred-again, window-create failure (retryable; both-fail → no surface).
 * - Default URL resolution: dev-server branch when `ELECTRON_RENDERER_URL`
 *   is present, packaged `index.html` (file://) branch otherwise (LOCK-CAT-8).
 * - The ordinary startup path is NOT altered (LOCK-CAT-9): the driver is only
 *   invoked by the startup gate when catalog recovery is required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRegister, mockDispose, mockAwaitReady, mockRunRecoveryV2, mockResolveRestartMode } = vi.hoisted(() => ({
  mockRegister: vi.fn(),
  mockDispose: vi.fn(),
  mockAwaitReady: vi.fn(),
  mockRunRecoveryV2: vi.fn(),
  mockResolveRestartMode: vi.fn(() => 'in-process-reload' as const)
}))

vi.mock('@main/config', () => ({
  DATA_PATH: '/mock/data'
}))

vi.mock('../promotion/catalogApplyIpc', () => ({
  registerCatalogRecoveryIpc: mockRegister,
  disposeCatalogRecoveryIpc: mockDispose,
  awaitCatalogRecoveryReady: mockAwaitReady,
  applyCandidateCatalog: vi.fn(),
  restoreCatalogSnapshot: vi.fn(),
  queryCatalogFacts: vi.fn()
}))

vi.mock('../promotion/recoveryExecutorV2', () => ({
  runRecoveryV2: mockRunRecoveryV2
}))

vi.mock('../promotion/restart', () => ({
  resolveRestartMode: mockResolveRestartMode,
  reloadMainRenderer: vi.fn(),
  getMainRendererWebContents: vi.fn()
}))

vi.mock('../promotion/relaunch', () => ({
  relaunchApp: vi.fn(() => ({ relaunched: true })),
  mintRelaunchReceipt: vi.fn((kind: string) => ({ kind, receipt: 'mock-receipt' }))
}))

import { app } from 'electron'

import {
  appendRecoveryQueryParams,
  buildRecoveryWindowUrl,
  buildTerminalRecoveryWindowUrl,
  type RecoveryWindowLike,
  runCatalogStartupRecovery
} from '../catalogStartupRecovery'

const CONVERGED = {
  ok: true as const,
  action: 'complete-catalog-apply',
  journalCleaned: true,
  restartRequested: false,
  deferredToWindow: false
}

type WindowLike = RecoveryWindowLike & {
  loadURL: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

function createWindowLike(): WindowLike {
  const wc = { isDestroyed: () => false } as never
  const window = {
    webContents: wc,
    loadURL: vi.fn(async () => undefined),
    show: vi.fn(),
    destroy: vi.fn()
  } as unknown as WindowLike
  return window
}

/** Window factory returning each given window once, then the last one. */
function windowSequence(...windows: WindowLike[]): () => WindowLike {
  let index = 0
  return () => {
    const window = windows[Math.min(index, windows.length - 1)]
    index += 1
    return window
  }
}

/** Factory that always throws (window creation failure). */
function throwingWindowFactory(): never {
  throw new Error('boom')
}

const LIVE_DB = {
  isInitialised: () => false
}

function baseOptions(window = createWindowLike()) {
  return {
    dataRoot: '/mock/data',
    createWindow: () => window,
    liveDb: LIVE_DB,
    restart: { mode: 'in-process-reload' as const, relaunch: () => ({ relaunched: false }) },
    resolveUrl: () => 'file:///mock/recovery.html?cherryImportRecovery=1'
  }
}

describe('buildRecoveryWindowUrl (LOCK-CAT-8, LOCK-BRIDGE-3)', () => {
  it('appends the recovery query parameter to the dev server URL', () => {
    expect(buildRecoveryWindowUrl('http://localhost:5173', '')).toBe('http://localhost:5173?cherryImportRecovery=1')
  })

  it('appends the recovery query parameter to the packaged HTML path', () => {
    expect(buildRecoveryWindowUrl(null, '/app/out/renderer/index.html')).toBe(
      '/app/out/renderer/index.html?cherryImportRecovery=1'
    )
  })

  it('preserves an existing query string AND sets exactly one recovery parameter (LOCK-BRIDGE-3)', () => {
    expect(buildRecoveryWindowUrl('http://localhost:5173/?lang=en', '')).toBe(
      'http://localhost:5173/?lang=en&cherryImportRecovery=1'
    )
  })

  it('preserves an existing hash after the recovery parameter (LOCK-BRIDGE-3)', () => {
    expect(buildRecoveryWindowUrl('http://localhost:5173/?lang=en#/settings', '')).toBe(
      'http://localhost:5173/?lang=en&cherryImportRecovery=1#/settings'
    )
    expect(buildRecoveryWindowUrl('/app/out/renderer/index.html#/route', '')).toBe(
      '/app/out/renderer/index.html?cherryImportRecovery=1#/route'
    )
  })

  it('deduplicates an existing cherryImportRecovery parameter instead of appending a second one (LOCK-BRIDGE-3)', () => {
    expect(buildRecoveryWindowUrl('http://localhost:5173/?cherryImportRecovery=1&lang=en', '')).toBe(
      'http://localhost:5173/?cherryImportRecovery=1&lang=en'
    )
    expect(buildRecoveryWindowUrl('http://localhost:5173/?cherryImportRecovery=0', '')).toBe(
      'http://localhost:5173/?cherryImportRecovery=1'
    )
  })

  it('joins an existing query on a bare filesystem path safely (LOCK-BRIDGE-3)', () => {
    expect(buildRecoveryWindowUrl('/app/out/renderer/index.html?lang=en', '')).toBe(
      '/app/out/renderer/index.html?lang=en&cherryImportRecovery=1'
    )
  })
})

describe('appendRecoveryQueryParams / buildTerminalRecoveryWindowUrl (LOCK-F2)', () => {
  it('sets multiple params on a scheme URL preserving existing query (deduplicated)', () => {
    expect(appendRecoveryQueryParams('http://localhost:5173/?lang=en', { a: '1', lang: 'zh' })).toBe(
      'http://localhost:5173/?lang=zh&a=1'
    )
  })

  it('builds the terminal repair URL with the bounded code on a dev URL', () => {
    expect(buildTerminalRecoveryWindowUrl('http://localhost:5173?cherryImportRecovery=1', 'READY_TIMEOUT')).toBe(
      'http://localhost:5173?cherryImportRecovery=1&cherryRecoveryTerminal=1&cherryRecoveryCode=READY_TIMEOUT'
    )
  })

  it('builds the terminal repair URL on a bare filesystem path', () => {
    expect(buildTerminalRecoveryWindowUrl('/app/out/renderer/index.html?cherryImportRecovery=1', 'LOAD_FAILED')).toBe(
      '/app/out/renderer/index.html?cherryImportRecovery=1&cherryRecoveryTerminal=1&cherryRecoveryCode=LOAD_FAILED'
    )
  })

  it('preserves an existing hash on the terminal URL', () => {
    expect(buildTerminalRecoveryWindowUrl('http://localhost:5173/?lang=en#/x', 'UNEXPECTED')).toBe(
      'http://localhost:5173/?lang=en&cherryImportRecovery=1&cherryRecoveryTerminal=1&cherryRecoveryCode=UNEXPECTED#/x'
    )
  })
})

describe('runCatalogStartupRecovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAwaitReady.mockResolvedValue({ ok: true })
    mockRunRecoveryV2.mockResolvedValue(CONVERGED)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('registers the boundary, loads the URL, awaits ready, converges, then disposes + destroys the window', async () => {
    const window = createWindowLike()
    const result = await runCatalogStartupRecovery(baseOptions(window))

    expect(result).toEqual({ ok: true, action: 'complete-catalog-apply', restartRequested: false })
    expect(mockRegister).toHaveBeenCalledWith(window.webContents)
    expect(window.loadURL).toHaveBeenCalledWith('file:///mock/recovery.html?cherryImportRecovery=1')
    // LOCK-BRIDGE-1: the ready handshake gates the executor invocation — the
    // recovery must never race the renderer handler mount.
    expect(mockAwaitReady).toHaveBeenCalled()
    const runCallOrder = mockAwaitReady.mock.invocationCallOrder[0]
    const execCallOrder = mockRunRecoveryV2.mock.invocationCallOrder[0]
    expect(runCallOrder).toBeLessThan(execCallOrder)
    expect(mockRunRecoveryV2).toHaveBeenCalledWith(
      expect.objectContaining({
        dataRoot: '/mock/data',
        catalogBoundary: expect.objectContaining({
          applyCandidate: expect.any(Function),
          restoreSnapshot: expect.any(Function),
          queryFacts: expect.any(Function)
        }),
        liveDb: LIVE_DB
      })
    )
    expect(mockDispose).toHaveBeenCalled()
    expect(window.destroy).toHaveBeenCalled()
    // Success path: the hidden window is never shown.
    expect(window.show).not.toHaveBeenCalled()
  })

  // =========================================================================
  // LOCK-F2: bounded retry — first transient failure → one fresh window
  // =========================================================================

  it('retries once with a FRESH window when the ready signal times out, then converges (LOCK-F2)', async () => {
    mockAwaitReady.mockResolvedValueOnce({ ok: false, code: 'READY_TIMEOUT' }).mockResolvedValueOnce({ ok: true })
    const firstWindow = createWindowLike()
    const secondWindow = createWindowLike()
    const result = await runCatalogStartupRecovery({
      ...baseOptions(),
      createWindow: windowSequence(firstWindow, secondWindow)
    })

    expect(result).toEqual({ ok: true, action: 'complete-catalog-apply', restartRequested: false })
    // Exactly one fresh-window recreation.
    expect(firstWindow.destroy).toHaveBeenCalled() // owned cleanup of the failed window
    expect(secondWindow.destroy).toHaveBeenCalled() // success destroys the final window
    expect(secondWindow.show).not.toHaveBeenCalled()
    expect(secondWindow.loadURL).toHaveBeenCalledWith('file:///mock/recovery.html?cherryImportRecovery=1')
    // The ready handshake re-ran against the fresh window before the executor.
    expect(mockAwaitReady).toHaveBeenCalledTimes(2)
    expect(mockRegister).toHaveBeenCalledTimes(2)
    expect(mockDispose).toHaveBeenCalledTimes(2)
    expect(mockRunRecoveryV2).toHaveBeenCalledTimes(1)
  })

  it('retries once with a FRESH window when the URL load fails, then converges (LOCK-F2)', async () => {
    const firstWindow = createWindowLike()
    firstWindow.loadURL.mockRejectedValueOnce(new Error('load failed'))
    const secondWindow = createWindowLike()
    const result = await runCatalogStartupRecovery({
      ...baseOptions(),
      createWindow: windowSequence(firstWindow, secondWindow)
    })

    expect(result).toEqual({ ok: true, action: 'complete-catalog-apply', restartRequested: false })
    expect(firstWindow.destroy).toHaveBeenCalled()
    expect(secondWindow.destroy).toHaveBeenCalled()
    // The executor never ran against the window that failed to load.
    expect(mockRunRecoveryV2).toHaveBeenCalledTimes(1)
    expect(secondWindow.loadURL).toHaveBeenCalledWith('file:///mock/recovery.html?cherryImportRecovery=1')
  })

  it('retries once when a catalog request transport failure surfaces through the executor (LOCK-F2)', async () => {
    mockRunRecoveryV2
      .mockResolvedValueOnce({ ok: false, code: 'CATALOG_APPLY_FAILED', safeCode: 'NO_TARGET' })
      .mockResolvedValueOnce(CONVERGED)
    const firstWindow = createWindowLike()
    const secondWindow = createWindowLike()
    const result = await runCatalogStartupRecovery({
      ...baseOptions(),
      createWindow: windowSequence(firstWindow, secondWindow)
    })

    expect(result).toEqual({ ok: true, action: 'complete-catalog-apply', restartRequested: false })
    expect(firstWindow.destroy).toHaveBeenCalled()
    expect(secondWindow.destroy).toHaveBeenCalled()
    expect(mockRunRecoveryV2).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a data-level executor failure — shows the terminal repair surface immediately (LOCK-F2)', async () => {
    mockRunRecoveryV2.mockResolvedValue({ ok: false, code: 'VERIFY_FAILED', safeCode: 'INSTALLED_GENERATION' })
    const window = createWindowLike()
    const result = await runCatalogStartupRecovery(baseOptions(window))

    expect(result).toEqual({ ok: false, code: 'VERIFY_FAILED', safeCode: null, terminalSurface: true })
    // No retry: exactly one window was created.
    expect(mockRunRecoveryV2).toHaveBeenCalledTimes(1)
    expect(window.destroy).not.toHaveBeenCalled() // kept alive for the repair surface
    expect(window.show).toHaveBeenCalled() // user-visible terminal repair state
    // The terminal URL carries ONLY the bounded machine code — never the
    // executor sub-code / paths / names / content / IDs (LOCK-F2).
    const terminalUrl = window.loadURL.mock.calls.at(-1)?.[0] as string
    expect(terminalUrl).toContain('cherryRecoveryTerminal=1')
    expect(terminalUrl).toContain('cherryRecoveryCode=VERIFY_FAILED')
    expect(terminalUrl).not.toContain('INSTALLED_GENERATION')
    expect(mockDispose).toHaveBeenCalled()
  })

  // =========================================================================
  // LOCK-F2: double failure / retry budget exhaustion
  // =========================================================================

  it('shows the terminal repair surface when BOTH attempts fail transiently (LOCK-F2 retry budget)', async () => {
    mockAwaitReady.mockResolvedValue({ ok: false, code: 'READY_TIMEOUT' })
    const firstWindow = createWindowLike()
    const secondWindow = createWindowLike()
    const result = await runCatalogStartupRecovery({
      ...baseOptions(),
      createWindow: windowSequence(firstWindow, secondWindow)
    })

    expect(result).toEqual({ ok: false, code: 'READY_TIMEOUT', safeCode: null, terminalSurface: true })
    expect(mockRunRecoveryV2).not.toHaveBeenCalled()
    expect(firstWindow.destroy).toHaveBeenCalled() // failed first window cleaned up
    expect(secondWindow.destroy).not.toHaveBeenCalled() // kept alive
    expect(secondWindow.show).toHaveBeenCalled() // user-visible repair surface
    const terminalUrl = secondWindow.loadURL.mock.calls.at(-1)?.[0] as string
    expect(terminalUrl).toContain('cherryRecoveryTerminal=1')
    expect(terminalUrl).toContain('cherryRecoveryCode=READY_TIMEOUT')
    expect(mockDispose).toHaveBeenCalledTimes(2)
  })

  it('shows the terminal repair surface when BOTH attempts fail to load the URL (LOCK-F2)', async () => {
    const firstWindow = createWindowLike()
    firstWindow.loadURL.mockRejectedValue(new Error('load failed 1'))
    const secondWindow = createWindowLike()
    secondWindow.loadURL.mockRejectedValue(new Error('load failed 2'))
    const result = await runCatalogStartupRecovery({
      ...baseOptions(),
      createWindow: windowSequence(firstWindow, secondWindow)
    })

    expect(result).toEqual({ ok: false, code: 'LOAD_FAILED', safeCode: null, terminalSurface: true })
    expect(firstWindow.destroy).toHaveBeenCalled()
    expect(secondWindow.destroy).not.toHaveBeenCalled()
    expect(secondWindow.show).toHaveBeenCalled()
    expect(mockRunRecoveryV2).not.toHaveBeenCalled()
  })

  // =========================================================================
  // LOCK-F2: window creation failure is retryable; both-fail → no surface
  // =========================================================================

  it('retries window creation once after WINDOW_CREATE_FAILED, then converges', async () => {
    const secondWindow = createWindowLike()
    let calls = 0
    const result = await runCatalogStartupRecovery({
      ...baseOptions(),
      createWindow: () => {
        calls += 1
        if (calls === 1) throw new Error('boom')
        return secondWindow
      }
    })

    expect(result).toEqual({ ok: true, action: 'complete-catalog-apply', restartRequested: false })
    expect(calls).toBe(2)
    expect(secondWindow.destroy).toHaveBeenCalled()
    expect(mockRegister).toHaveBeenCalledTimes(1)
  })

  it('returns WINDOW_CREATE_FAILED with no terminal surface when window creation fails twice', async () => {
    const result = await runCatalogStartupRecovery({
      ...baseOptions(),
      createWindow: throwingWindowFactory
    })
    expect(result).toEqual({ ok: false, code: 'WINDOW_CREATE_FAILED', safeCode: null, terminalSurface: false })
    expect(mockRegister).not.toHaveBeenCalled()
  })

  // =========================================================================
  // Result mapping (unchanged semantics + LOCK-F2 terminal flag)
  // =========================================================================

  it('reports a relaunch-pending outcome when the executor requested a restart', async () => {
    mockRunRecoveryV2.mockResolvedValue({ ...CONVERGED, restartRequested: true })
    const window = createWindowLike()
    const result = await runCatalogStartupRecovery(baseOptions(window))
    expect(result).toEqual({ ok: true, action: 'complete-catalog-apply', restartRequested: true })
    // The window is still cleaned up even on the relaunch path.
    expect(window.destroy).toHaveBeenCalled()
    expect(mockDispose).toHaveBeenCalled()
  })

  it('fails closed with READY_TIMEOUT terminal surface when the renderer never signals ready on BOTH attempts', async () => {
    mockAwaitReady.mockResolvedValue({ ok: false, code: 'READY_TIMEOUT' })
    const firstWindow = createWindowLike()
    const secondWindow = createWindowLike()
    const result = await runCatalogStartupRecovery({
      ...baseOptions(),
      createWindow: windowSequence(firstWindow, secondWindow)
    })
    expect(result).toEqual({ ok: false, code: 'READY_TIMEOUT', safeCode: null, terminalSurface: true })
    // The recovery executor must never run when the handler never mounted.
    expect(mockRunRecoveryV2).not.toHaveBeenCalled()
    expect(mockDispose).toHaveBeenCalled()
    expect(firstWindow.destroy).toHaveBeenCalled()
    expect(secondWindow.show).toHaveBeenCalled()
  })

  it('shows the terminal repair surface when the ready target was lost on both attempts', async () => {
    mockAwaitReady.mockResolvedValue({ ok: false, code: 'NO_TARGET' })
    const firstWindow = createWindowLike()
    const secondWindow = createWindowLike()
    const result = await runCatalogStartupRecovery({
      ...baseOptions(),
      createWindow: windowSequence(firstWindow, secondWindow)
    })
    expect(result).toEqual({ ok: false, code: 'READY_FAILED', safeCode: null, terminalSurface: true })
    expect(mockRunRecoveryV2).not.toHaveBeenCalled()
    expect(firstWindow.destroy).toHaveBeenCalled()
    expect(secondWindow.show).toHaveBeenCalled()
  })

  it('fails closed when the recovery is deferred again (boundary still unavailable)', async () => {
    mockRunRecoveryV2.mockResolvedValue({ ...CONVERGED, deferredToWindow: true })
    const window = createWindowLike()
    const result = await runCatalogStartupRecovery(baseOptions(window))
    expect(result).toEqual({ ok: false, code: 'DEFERRED_AGAIN', safeCode: null, terminalSurface: true })
    expect(window.destroy).not.toHaveBeenCalled()
    expect(window.show).toHaveBeenCalled()
  })

  it('maps a non-transient executor failure to a terminal result without retry', async () => {
    mockRunRecoveryV2.mockResolvedValue({
      ok: false,
      code: 'CATALOG_APPLY_FAILED',
      safeCode: 'CANDIDATE_CATALOG_UNAVAILABLE'
    })
    const window = createWindowLike()
    const result = await runCatalogStartupRecovery(baseOptions(window))
    expect(result).toEqual({
      ok: false,
      code: 'CATALOG_APPLY_FAILED',
      safeCode: null,
      terminalSurface: true
    })
    expect(mockRunRecoveryV2).toHaveBeenCalledTimes(1)
    expect(window.destroy).not.toHaveBeenCalled()
    expect(window.show).toHaveBeenCalled()
    const terminalUrl = window.loadURL.mock.calls.at(-1)?.[0] as string
    expect(terminalUrl).toContain('cherryRecoveryCode=CATALOG_APPLY_FAILED')
    expect(terminalUrl).not.toContain('CANDIDATE_CATALOG_UNAVAILABLE')
  })

  it('forwards the injectable restart and primitives to the executor', async () => {
    const restart = { mode: 'relaunch' as const, relaunch: () => ({ relaunched: true }) }
    const primitives = { markRepairRequiredBeforeInit: vi.fn() }
    const window = createWindowLike()
    await runCatalogStartupRecovery({
      ...baseOptions(window),
      restart,
      primitives
    })
    expect(mockRunRecoveryV2).toHaveBeenCalledWith(expect.objectContaining({ restart, primitives }))
  })
})

describe('production default URL resolution (LOCK-CAT-8)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunRecoveryV2.mockResolvedValue(CONVERGED)
    ;(app as unknown as { isPackaged: boolean }).isPackaged = false
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses the dev server URL when running unpackaged with ELECTRON_RENDERER_URL', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    const window = createWindowLike()
    await runCatalogStartupRecovery({ ...baseOptions(window), resolveUrl: undefined })
    expect(window.loadURL).toHaveBeenCalledWith('http://localhost:5173?cherryImportRecovery=1')
  })

  it('uses the packaged index.html (file:// URL) when no dev server URL is present', async () => {
    const window = createWindowLike()
    await runCatalogStartupRecovery({ ...baseOptions(window), resolveUrl: undefined })
    const loaded = window.loadURL.mock.calls[0][0] as string
    // LOCK-CAT-8 / LOCK-F2: the packaged form is a proper file:// URL so
    // webContents.loadURL accepts it, with the recovery parameter appended.
    expect(loaded).toContain('file://')
    expect(loaded).toContain('index.html?cherryImportRecovery=1')
  })

  it('uses the packaged index.html even unpackaged when no renderer URL is present', async () => {
    const window = createWindowLike()
    await runCatalogStartupRecovery({ ...baseOptions(window), resolveUrl: undefined })
    const loaded = window.loadURL.mock.calls[0][0] as string
    expect(loaded).toContain('file://')
    expect(loaded).toContain('index.html?cherryImportRecovery=1')
  })

  it('always uses the packaged index.html when packaged', async () => {
    ;(app as unknown as { isPackaged: boolean }).isPackaged = true
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    const window = createWindowLike()
    await runCatalogStartupRecovery({ ...baseOptions(window), resolveUrl: undefined })
    const loaded = window.loadURL.mock.calls[0][0] as string
    expect(loaded).toContain('file://')
    expect(loaded).toContain('index.html?cherryImportRecovery=1')
  })

  it('resolves the packaged default restart mode through resolveRestartMode', async () => {
    mockResolveRestartMode.mockReturnValue('in-process-reload')
    const window = createWindowLike()
    const result = await runCatalogStartupRecovery({ ...baseOptions(window), restart: undefined })
    expect(result.ok).toBe(true)
    expect(mockResolveRestartMode).toHaveBeenCalled()
  })
})
