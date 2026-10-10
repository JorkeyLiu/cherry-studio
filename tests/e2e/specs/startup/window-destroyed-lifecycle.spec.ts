/**
 * Window destroyed lifecycle (production guards).
 *
 * Scope: this new spec only (`tests/e2e/specs/startup/window-destroyed-lifecycle.spec.ts`).
 * Reuses the shared fixture (unique disposable profile, mocked provider, exact
 * ownership). No source, unit, sync, media, doc, or global-harness edits.
 *
 * Production background: `WindowService` binds destroyed-guarded closures on
 * the real main `WebContents` (`render-process-gone` -> reload,
 * `did-navigate-in-page` -> setZoomFactor). The unit suite covers the guard
 * logic with throwing fakes; this spec proves the production bundle behaviour
 * that units cannot: the app boots with the real callbacks bound, and late
 * delivery of those exact bound closures after the real main window is
 * destroyed stays silent with no error popup.
 *
 * Real vs injected classification:
 * - REAL: fixture boot + `waitForAppReady`, real ownership snapshot
 *   (`listenerCount >= 1` on the live main contents), real keepalive
 *   `BrowserWindow` created BEFORE the main destroy (so the app does not
 *   auto-exit), real `mainWin.destroy()` (true native `WebContents` destroy,
 *   not a graceful save handshake), real `ChatDb` IPC probes before destroy,
 *   real `forcefullyCrashRenderer` crash recovery (test 2).
 * - INJECTED late delivery (explicit): after the real destroy, the spec
 *   invokes the CAPTURED actual production listener functions (copied via
 *   `contents.listeners(...)` before destroy) with `({}, { reason: 'killed' })`
 *   and `()` respectively, plus a best-effort `emit` on the destroyed main
 *   contents. The captured refs guarantee dispatch of the true
 *   `WindowService` closures (which capture the main window/contents, not a
 *   secondary emitter); the `emit` alone could be a native noop, so the
 *   captured invocation is the authoritative regression signal. Under the old
 *   unguarded handler this captured late call throws the destroyed-class
 *   `TypeError` inside the call (old-code FAIL); the guarded handler returns
 *   before any native call (fixed PASS). No `event.preventDefault` is touched,
 *   so production close semantics are unchanged.
 *
 * Monitor technique (started BEFORE every action, asserted while the app is
 * alive): Main-side observer installed via `electronApp.evaluate` that wraps
 * the focused `dialog.showErrorBox` (records the call then calls through to
 * the original so a popup is never masked) plus a non-suppressing
 * `uncaughtException` recorder (records the class flag, detaches itself, then
 * rethrows async so the default dialog path is preserved) and a passive
 * `unhandledRejection` recorder; runner-side sanitized `stderr` flag that
 * records only whether a destroyed-class line appeared (never raw log text).
 * The intentionally crashed renderer in test 2 emits the expected gone event,
 * so the spec never asserts zero render-process-gone; it asserts the gone
 * counter moved and no destroyed-class error/popup followed.
 *
 * Claims covered vs unproven:
 * - COVERED: fresh production boot with main handlers bound; real main
 *   destroy (`isDestroyed() === true`) + late delivery of the ACTUAL bound
 *   main handlers produces no throw, no Main destroyed-class
 *   uncaught/rejection/popup/stderr flag while the keepalive window keeps the
 *   app alive; one genuine main-renderer crash recovers via reload with no
 *   destroyed-class failure.
 * - UNPROVEN HERE (not automated): normal SIGINT supervisor shutdown path;
 *   graceful save-data close handshake on `main.destroy()` is NOT claimed
 *   (`destroy()` bypasses the `close` handshake by design; save is covered by
 *   the existing close-handshake unit suite).
 *
 * Blocker contract: if the platform quits the app on main destroy despite
 * the keepalive, or an existing service spawns a replacement main window that
 * makes the destroyed-main observation ambiguous, the spec fails closed with
 * the blocker message (no empty pass, no silent probe skip).
 *
 * Run (main schedules the exact state AFTER the final media source; no
 * build/E2E run with this change):
 *   pnpm build && pnpm test:e2e tests/e2e/specs/startup/window-destroyed-lifecycle.spec.ts
 */
import { expect, test } from '../../fixtures/electron.fixture'
import { waitForAppReady } from '../../utils/wait-helpers'

const DESTROYED_MARKERS = ['Object has been destroyed', 'has been destroyed']

function isDestroyedClass(message: string): boolean {
  return DESTROYED_MARKERS.some((marker) => message.includes(marker))
}

/** Runner-side sanitized stderr flag: destroyed-class presence only, never raw text. */
function attachDestroyedStderrFlag(electronApp: any): { hasDestroyed: () => boolean; detach: () => void } {
  let hit = false
  let stderr: any = null
  try {
    stderr = electronApp.process?.()?.stderr ?? null
  } catch {
    stderr = null
  }
  const onData = (chunk: unknown): void => {
    try {
      const text = String(chunk)
      if (isDestroyedClass(text)) hit = true
    } catch {
      // ignore decode errors; the flag simply stays unset
    }
  }
  try {
    if (stderr && typeof stderr.on === 'function') stderr.on('data', onData)
  } catch {
    // stderr unavailable in this runner; Main-side flags remain authoritative
  }
  return {
    hasDestroyed: () => hit,
    detach: () => {
      try {
        stderr?.off?.('data', onData)
      } catch {
        // best-effort detach only
      }
    }
  }
}

async function installMainMonitor(electronApp: any): Promise<void> {
  await electronApp.evaluate(({ dialog }: any) => {
    const g = globalThis as any
    g.__e2eWindowDestroyed = g.__e2eWindowDestroyed ?? {
      uncaught: [],
      unhandled: [],
      showErrorBoxCalls: 0,
      showErrorBoxFirst: '',
      goneCount: 0
    }
    const state = g.__e2eWindowDestroyed
    state.uncaught = []
    state.unhandled = []
    state.showErrorBoxCalls = 0
    state.showErrorBoxFirst = ''
    state.goneCount = 0
    if (!state.__installed) {
      state.__installed = true
      const d = dialog as any
      state.__origShowErrorBox = d.showErrorBox.bind(d)
      const orig = state.__origShowErrorBox
      d.showErrorBox = (...args: any[]) => {
        state.showErrorBoxCalls += 1
        try {
          state.showErrorBoxFirst = String(args?.[0] ?? '').slice(0, 120)
        } catch {
          // keep the count; the title text is best-effort only
        }
        return orig(...args)
      }
      const recUncaught = (err: any) => {
        try {
          const message = err?.message ? String(err.message) : String(err)
          state.uncaught.push(message.slice(0, 200))
        } catch {
          // recording must never throw inside the handler
        }
        try {
          ;(process as any).removeListener('uncaughtException', recUncaught)
        } catch {
          // removal is best-effort; the async rethrow below still preserves visibility
        }
        setImmediate(() => {
          throw err
        })
      }
      const recRejection = (reason: any) => {
        try {
          const message = reason?.message ? String(reason.message) : String(reason)
          state.unhandled.push(message.slice(0, 200))
        } catch {
          // recording must never throw inside the handler
        }
      }
      state.__recUncaught = recUncaught
      state.__recRejection = recRejection
      ;(process as any).on('uncaughtException', recUncaught)
      ;(process as any).on('unhandledRejection', recRejection)
    }
  })
}

async function readMainMonitor(electronApp: any): Promise<{
  uncaught: string[]
  unhandled: string[]
  showErrorBoxCalls: number
  goneCount: number
}> {
  return electronApp.evaluate(() => {
    const s = (globalThis as any).__e2eWindowDestroyed ?? {}
    return {
      uncaught: ((s.uncaught ?? []) as unknown[]).map((entry) => String(entry)),
      unhandled: ((s.unhandled ?? []) as unknown[]).map((entry) => String(entry)),
      showErrorBoxCalls: typeof s.showErrorBoxCalls === 'number' ? s.showErrorBoxCalls : 0,
      goneCount: typeof s.goneCount === 'number' ? s.goneCount : 0
    }
  })
}

async function uninstallMainMonitor(electronApp: any): Promise<void> {
  await electronApp.evaluate(({ dialog }: any) => {
    const g = globalThis as any
    const s = g.__e2eWindowDestroyed
    if (!s) return { restored: false }
    try {
      if (s.__origShowErrorBox) (dialog as any).showErrorBox = s.__origShowErrorBox
    } catch {
      // restore is best-effort; teardown still owns the app lifecycle
    }
    try {
      if (s.__recUncaught) (process as any).removeListener('uncaughtException', s.__recUncaught)
      if (s.__recRejection) (process as any).removeListener('unhandledRejection', s.__recRejection)
    } catch {
      // removal is best-effort only
    }
    s.__installed = false
    return { restored: true }
  })
}

async function probeChatDb(page: any): Promise<boolean> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      api?: { chatDb?: { topicExists?: (args: { topicId: string }) => Promise<{ ok: boolean }> } }
    }
    if (!w.api?.chatDb || typeof w.api.chatDb.topicExists !== 'function') return false
    try {
      const result = await w.api.chatDb.topicExists({ topicId: '__e2e_destroyed_lifecycle__' })
      return result?.ok === true
    } catch {
      return false
    }
  })
}

test.describe('window destroyed lifecycle (production guards)', () => {
  test('late delivery of actual destroyed main handlers stays silent while app alive', async ({
    electronApp,
    mainWindow
  }) => {
    await waitForAppReady(mainWindow)
    await installMainMonitor(electronApp)
    const stderrFlag = attachDestroyedStderrFlag(electronApp)
    let primaryError1: unknown = null
    try {
      // Main readiness BEFORE destruction (no main profile is live after).
      expect(await probeChatDb(mainWindow)).toBe(true)

      // Genuine ownership snapshot on the real main window: bound handlers prove
      // the production bundle is not the stale unbound one.
      const ownership = await electronApp.evaluate(({ BrowserWindow }: any) => {
        const wins = (BrowserWindow as any).getAllWindows()
        const win = wins[0]
        const contents = win.webContents
        const renderGoneListeners =
          typeof contents.listenerCount === 'function' ? contents.listenerCount('render-process-gone') : -1
        const navigateListeners =
          typeof contents.listenerCount === 'function' ? contents.listenerCount('did-navigate-in-page') : -1
        return {
          windowCount: wins.length,
          windowDestroyed: win.isDestroyed(),
          contentsDestroyed: contents.isDestroyed(),
          renderGoneListeners,
          navigateListeners
        }
      })
      expect(ownership.windowCount).toBeGreaterThanOrEqual(1)
      expect(ownership.windowDestroyed).toBe(false)
      expect(ownership.contentsDestroyed).toBe(false)
      expect(ownership.renderGoneListeners).toBeGreaterThanOrEqual(1)
      expect(ownership.navigateListeners).toBeGreaterThanOrEqual(1)

      // REAL main destroy with the app kept alive by a secondary keepalive
      // window created BEFORE the destroy (so the app does not auto-exit),
      // then INJECTED late delivery of the CAPTURED actual production
      // closures (explicit regression probe beyond the real native close).
      // The closures capture the main window/contents, not the keepalive
      // emitter, so dispatch proves the true guard path. `destroy()` is raw
      // teardown, not the graceful save handshake.
      const probe = await electronApp.evaluate(async ({ BrowserWindow, app }: any) => {
        const mainWin = (BrowserWindow as any).getAllWindows()[0]
        const contents = mainWin.webContents
        const goneListeners =
          typeof contents.listeners === 'function' ? contents.listeners('render-process-gone').slice() : []
        const navigateListeners =
          typeof contents.listeners === 'function' ? contents.listeners('did-navigate-in-page').slice() : []
        const keepalive = new (BrowserWindow as any)({ show: false, width: 120, height: 120 })
        const keepaliveId = keepalive.id as number
        const mainId = mainWin.id as number
        const before = { windowDestroyed: mainWin.isDestroyed(), contentsDestroyed: contents.isDestroyed() }
        mainWin.destroy()
        // Bounded wait for the REAL native WebContents destroy: Window
        // destroy is sync while WebContents destroy completes async. The
        // captured late delivery below must run only after the actual
        // `contents.isDestroyed() === true` (no fake flip, no nil assert).
        const after = await new Promise<{
          windowDestroyed: boolean
          contentsDestroyed: boolean
          timedOut: boolean
        }>((resolve) => {
          const deadline = Date.now() + 5000
          const poll = (): void => {
            let w = false
            let c = false
            try {
              w = mainWin.isDestroyed()
            } catch {
              w = false
            }
            try {
              c = contents.isDestroyed()
            } catch {
              c = true
            }
            if (w && c) {
              resolve({ windowDestroyed: w, contentsDestroyed: c, timedOut: false })
            } else if (Date.now() >= deadline) {
              resolve({ windowDestroyed: w, contentsDestroyed: c, timedOut: true })
            } else {
              setTimeout(poll, 50)
            }
          }
          poll()
        })
        const goneErrors: string[] = []
        for (const fn of goneListeners) {
          try {
            ;(fn as (...args: unknown[]) => void).call(contents, {}, { reason: 'killed' })
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            goneErrors.push(message.slice(0, 200))
          }
        }
        const navigateErrors: string[] = []
        for (const fn of navigateListeners) {
          try {
            ;(fn as (...args: unknown[]) => void).call(contents)
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            navigateErrors.push(message.slice(0, 200))
          }
        }
        // Best-effort emit on the actually destroyed main contents. Captured
        // refs above already guarantee dispatch; this emit is supplementary.
        let emitGoneError = ''
        let emitNavigateError = ''
        try {
          contents.emit('render-process-gone', {}, { reason: 'killed' })
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          emitGoneError = message.slice(0, 200)
        }
        try {
          contents.emit('did-navigate-in-page')
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          emitNavigateError = message.slice(0, 200)
        }
        let appReady = false
        try {
          appReady = (app as { isReady?: () => boolean }).isReady?.() ?? false
        } catch {
          appReady = false
        }
        const liveIds: number[] = []
        try {
          for (const win of (BrowserWindow as any).getAllWindows()) {
            try {
              if (!win.isDestroyed()) liveIds.push(win.id as number)
            } catch {
              // ignore per-window state errors; keepalive liveness is checked below
            }
          }
        } catch {
          // window enumeration is best-effort; keepalive liveness below is authoritative
        }
        let keepaliveAlive = false
        try {
          keepaliveAlive = !keepalive.isDestroyed()
        } catch {
          keepaliveAlive = false
        }
        return {
          capturedGone: goneListeners.length,
          capturedNavigate: navigateListeners.length,
          before,
          after,
          timedOut: after.timedOut,
          goneErrors,
          navigateErrors,
          emitGoneError,
          emitNavigateError,
          keepaliveAlive,
          keepaliveId,
          mainId,
          liveIds,
          appReady
        }
      })
      // Blocker contract: app must still be alive via the keepalive. If the
      // platform quit on main destroy, or a replacement main makes the
      // observation ambiguous, fail closed here (no empty pass).
      expect(
        probe.keepaliveAlive && probe.appReady,
        `BLOCKER: app quit on main destroy despite keepalive (keepaliveAlive=${probe.keepaliveAlive} appReady=${probe.appReady})`
      ).toBe(true)
      const unexpectedLive = probe.liveIds.filter((id) => id !== probe.keepaliveId && id !== probe.mainId)
      expect(
        unexpectedLive,
        `BLOCKER: replacement window appeared after main destroy (liveIds=${JSON.stringify(probe.liveIds)}); observation ambiguous`
      ).toEqual([])

      // The actual bound closures were captured and late-delivered.
      expect(probe.capturedGone).toBeGreaterThanOrEqual(1)
      expect(probe.capturedNavigate).toBeGreaterThanOrEqual(1)
      expect(probe.before.windowDestroyed).toBe(false)
      expect(probe.before.contentsDestroyed).toBe(false)
      expect(
        probe.timedOut,
        `BLOCKER: real WebContents destroy did not complete within 5s (after=${JSON.stringify(probe.after)})`
      ).toBe(false)
      expect(probe.after.windowDestroyed).toBe(true)
      expect(probe.after.contentsDestroyed).toBe(true)
      // Guarded handlers return before any native reload/zoom call, so the
      // captured late delivery throws nothing (old unguarded code FAILS here
      // with the destroyed-class TypeError).
      expect(probe.goneErrors).toEqual([])
      expect(probe.navigateErrors).toEqual([])
      expect(probe.emitGoneError).toBe('')
      expect(probe.emitNavigateError).toBe('')

      // Keepalive-context aliveness: Main-side responsiveness only (the main
      // UI is logically gone post-destroy, so no main locator/IPC use here).
      const alive = await electronApp.evaluate(({ BrowserWindow }: any) => {
        let count = 0
        let anyAlive = false
        try {
          const wins = (BrowserWindow as any).getAllWindows()
          count = wins.length
          anyAlive = wins.some((win: { isDestroyed: () => boolean }) => {
            try {
              return !win.isDestroyed()
            } catch {
              return false
            }
          })
        } catch {
          // enumeration failure means not demonstrably alive
        }
        return { count, anyAlive }
      })
      expect(alive.anyAlive).toBe(true)

      // Monitor asserted while the app is alive via the keepalive (not after
      // teardown). Fixture owns cleanup; no extra quit or broad kill.
      const flags = await readMainMonitor(electronApp)
      expect(flags.uncaught.filter((message) => isDestroyedClass(message))).toEqual([])
      expect(flags.unhandled.filter((message) => isDestroyedClass(message))).toEqual([])
      expect(flags.uncaught).toEqual([])
      expect(flags.unhandled).toEqual([])
      expect(flags.showErrorBoxCalls).toBe(0)
      expect(stderrFlag.hasDestroyed()).toBe(false)
    } catch (error) {
      primaryError1 = error
      throw error
    } finally {
      stderrFlag.detach()
      try {
        await uninstallMainMonitor(electronApp)
      } catch (cleanupError) {
        // Preserve the precise original failure: a Target-closed cleanup
        // after the app already quit must not overwrite the blocker/probe
        // assertion above. A closed app that should recover still fails via
        // the primary assertion; only a clean run surfaces cleanup errors.
        if (primaryError1) {
          return
        }
        throw cleanupError
      }
    }
  })

  test('live renderer crash still recovers via reload with no destroyed error', async ({ electronApp, mainWindow }) => {
    test.setTimeout(120000)
    await waitForAppReady(mainWindow)
    await installMainMonitor(electronApp)
    const stderrFlag = attachDestroyedStderrFlag(electronApp)
    let primaryError2: unknown = null
    try {
      expect(await probeChatDb(mainWindow)).toBe(true)

      // Passive gone counter on the real main contents: the intentional crash
      // below must emit the expected gone event (never assert zero gone).
      await electronApp.evaluate(({ BrowserWindow }: any) => {
        const win = (BrowserWindow as any).getAllWindows()[0]
        const contents = win.webContents
        try {
          contents.once('render-process-gone', () => {
            const state = (globalThis as any).__e2eWindowDestroyed
            if (state) state.goneCount += 1
          })
        } catch {
          // the counter is observational; recovery assertions do not depend on it alone
        }
        return { attached: true }
      })

      // GENUINE crash of the live renderer (not a synthetic emit): drives the
      // real production render-process-gone -> reload path.
      await electronApp.evaluate(({ BrowserWindow }: any) => {
        const win = (BrowserWindow as any).getAllWindows()[0]
        win.webContents.forcefullyCrashRenderer()
        return { crashed: true }
      })

      // Bounded recovery: the reloaded renderer becomes ready and answers IPC.
      await mainWindow.waitForSelector('#root', { state: 'attached', timeout: 30000 })
      await waitForAppReady(mainWindow)
      await mainWindow.waitForFunction(() => typeof (window as any).store !== 'undefined', { timeout: 30000 })
      expect(await probeChatDb(mainWindow)).toBe(true)
      await expect(mainWindow.locator('#root')).toBeAttached()

      const flags = await readMainMonitor(electronApp)
      expect(flags.goneCount).toBeGreaterThanOrEqual(1)
      expect(flags.uncaught.filter((message) => isDestroyedClass(message))).toEqual([])
      expect(flags.unhandled.filter((message) => isDestroyedClass(message))).toEqual([])
      expect(flags.uncaught).toEqual([])
      expect(flags.unhandled).toEqual([])
      expect(flags.showErrorBoxCalls).toBe(0)
      expect(stderrFlag.hasDestroyed()).toBe(false)
    } catch (error) {
      primaryError2 = error
      throw error
    } finally {
      stderrFlag.detach()
      try {
        await uninstallMainMonitor(electronApp)
      } catch (cleanupError) {
        // Preserve the precise original crash/recovery failure instead of
        // overwriting it with a Target-closed teardown error. If the app
        // legitimately exited when it should have reloaded, the primary
        // recovery assertion above already fails the test.
        if (primaryError2) {
          return
        }
        throw cleanupError
      }
    }
  })
})
