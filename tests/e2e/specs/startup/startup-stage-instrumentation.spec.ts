/**
 * Startup stage instrumentation E2E (S7.13) — synthetic disposable-profile only.
 *
 * Default-off/fail-closed: plain `pnpm test:e2e` stays inert and this spec is
 * skipped. Synthetic harness run requires BOTH gates and synthetic profile:
 *   STARTUP_STAGE_ATTR=1 STARTUP_STAGE_SYNTHETIC=1 pnpm test:e2e -- tests/e2e/specs/startup/startup-stage-instrumentation.spec.ts
 * Build must also have been done with STARTUP_STAGE_ATTR=1 (inlined define).
 * The fixture guarantees a unique disposable userDataDir under an owned root with
 * exact cleanup; no persistent artifacts or raw profile paths are logged.
 */
import { expect, test } from '../../fixtures/electron.fixture'
import { epochComparable, validateStartupRecords } from '../../utils/startupStage'

const STARTUP_STAGE_VALIDATED_ENV = '__CHERRY_STARTUP_STAGE_VALIDATED'

function gateEnabled(): boolean {
  const a = process.env.STARTUP_STAGE_ATTR
  const s = process.env.STARTUP_STAGE_SYNTHETIC
  const norm = (v: string | undefined) => v?.trim().toLowerCase() === '1' || v?.trim().toLowerCase() === 'true'
  return norm(a) && norm(s)
}

test.describe('startup stage instrumentation (synthetic disposable)', () => {
  test.skip(
    !gateEnabled(),
    'STARTUP_STAGE_ATTR=1 + STARTUP_STAGE_SYNTHETIC=1 required (synthetic disposable harness only)'
  )

  test('records bounded privacy-safe stages on comparable epoch timeline', async ({ mainWindow, electronApp }) => {
    // Prove causal Main-authoritative marker without raw paths — check opaque marker presence
    const mainMarker = await electronApp.evaluate((envName) => {
      try {
        return (process as any).env?.[envName] ?? null
      } catch {
        return null
      }
    }, STARTUP_STAGE_VALIDATED_ENV)
    const rendererMarker = await mainWindow.evaluate((envName) => {
      try {
        const winAny = window as unknown as { electron?: { process?: { env?: Record<string, string> } } }
        const fromElectron = winAny.electron?.process?.env?.[envName]
        if (typeof fromElectron === 'string') return fromElectron
        const fromProcess = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env?.[
          envName
        ]
        if (typeof fromProcess === 'string') return fromProcess
        return null
      } catch {
        return null
      }
    }, STARTUP_STAGE_VALIDATED_ENV)

    // Collect renderer state via test seam (mainWindow)
    const rendererState = await mainWindow.evaluate(() => {
      const fn = (globalThis as any).__startupStageRead
      return typeof fn === 'function'
        ? fn()
        : { enabled: false, records: [], overflowed: false, epochAnchorMs: 0, perfAnchorMs: 0 }
    })
    // Collect Main state via existing test-only Main-context global seam (electronApp)
    const mainState = await electronApp.evaluate(() => {
      const fn = (globalThis as any).__startupStageRead
      return typeof fn === 'function'
        ? fn()
        : { enabled: false, records: [], overflowed: false, epochAnchorMs: 0, perfAnchorMs: 0 }
    })

    // Both processes must be enabled via positive disposable-profile validation
    expect(mainState.enabled).toBe(true)
    expect(rendererState.enabled).toBe(true)

    // Causal marker: Main must have set opaque marker after exact validation, renderer must have inherited it
    // No raw paths checked — marker is opaque '1' set only on Main success before BrowserWindow creation
    expect(mainMarker).toBe('1')
    expect(rendererMarker).toBe('1')

    const mainProblems = validateStartupRecords(mainState)
    expect(mainProblems, `main startup record problems: ${mainProblems.join('; ')}`).toEqual([])
    const rendererProblems = validateStartupRecords(rendererState)
    expect(rendererProblems, `renderer startup record problems: ${rendererProblems.join('; ')}`).toEqual([])

    // Comparable epoch timeline via shared anchor (Main + renderer within 60s)
    expect(epochComparable(mainState as any, rendererState as any)).toBe(true)

    // Expected renderer stages: both gate-ready milestones must be present and ordered
    const rStages = rendererState.records.map((r: any) => r.stage)
    expect(rStages).toEqual(expect.arrayContaining(['renderer.bootstrap']))
    expect(rStages).toEqual(expect.arrayContaining(['renderer.persistRehydrate']))
    expect(rStages).toEqual(expect.arrayContaining(['renderer.importProjectionReady']))
    expect(rStages).toEqual(expect.arrayContaining(['renderer.ordinaryTreeReady']))
    const idxImport = rStages.indexOf('renderer.importProjectionReady')
    const idxOrd = rStages.indexOf('renderer.ordinaryTreeReady')
    expect(idxImport).toBeGreaterThanOrEqual(0)
    expect(idxOrd).toBeGreaterThanOrEqual(0)
    expect(idxImport).toBeLessThan(idxOrd)

    // Main should have at least some sequential stages (restore, chatDbInit, etc.)
    const mStages = mainState.records.map((r: any) => r.stage)
    expect(mStages.length).toBeGreaterThan(0)

    // No content/paths in reasons for both processes
    for (const r of [...mainState.records, ...rendererState.records]) {
      if ((r as any).reason) {
        expect((r as any).reason).not.toMatch(/[\/\\]/)
        expect((r as any).reason.length).toBeLessThanOrEqual(64)
      }
      // Strict non-negative checks for epoch/duration
      expect(Number.isFinite((r as any).epochMs) && (r as any).epochMs >= 0).toBe(true)
      expect(Number.isFinite((r as any).durationMs) && (r as any).durationMs >= 0).toBe(true)
    }

    // Comparable epoch anchors: both within 60s of wall-clock
    const now = Date.now()
    expect(Math.abs(rendererState.epochAnchorMs - now)).toBeLessThan(60_000)
    expect(Math.abs(mainState.epochAnchorMs - now)).toBeLessThan(60_000)
  })
})
