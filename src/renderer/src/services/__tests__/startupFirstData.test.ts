import { STARTUP_STAGE_VALIDATED_ENV } from '@shared/diagnostics/startupStage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('Renderer startup firstData — S7.14-E1 default-off one-shot interval', () => {
  beforeEach(() => {
    vi.resetModules()
    delete (globalThis as any).process?.env?.STARTUP_STAGE_ATTR
    delete (globalThis as any).process?.env?.STARTUP_STAGE_SYNTHETIC
    delete (globalThis as any).process?.env?.[STARTUP_STAGE_VALIDATED_ENV]
    if (!(globalThis as any).process) (globalThis as any).process = { env: {} }
    delete (globalThis as any).process.env.STARTUP_STAGE_ATTR
    delete (globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC
    delete (globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV]
    ;(globalThis as any).window = {}
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'false')
    // ensure VITEST true for isolated test seam (renderer validation lexical bypass)
    if (!(globalThis as any).process) (globalThis as any).process = { env: { VITEST: 'true' } }
    else (globalThis as any).process.env.VITEST = 'true'
  })

  it('inert by default — instrument does not emit firstData', async () => {
    const mod = await import('../startupStageDiagnostics')
    expect(mod.isStartupStageEnabled()).toBe(false)
    // even after ordinaryTreeReady, instrumentation stays inert
    mod.markStartupMilestone('renderer.ordinaryTreeReady')
    const p = Promise.resolve('ok')
    mod.instrumentFirstDataWindow(p as any)
    await p
    await new Promise((r) => setTimeout(r, 0))
    expect(mod.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
  })

  it('fail-closed when no ordinaryTreeReady timestamp yet', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    ;(globalThis as any).process.env.STARTUP_STAGE_ATTR = '1'
    ;(globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC = '1'
    ;(globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV] = '1'
    const mod = await import('../startupStageDiagnostics')
    expect(mod.isStartupStageEnabled()).toBe(true)
    // do NOT mark ordinaryTreeReady
    const p = Promise.resolve('ok')
    mod.instrumentFirstDataWindow(p as any)
    await p
    await new Promise((r) => setTimeout(r, 0))
    expect(mod.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
    // now mark ready and try again — next window should record
    mod.markStartupMilestone('renderer.ordinaryTreeReady')
    const p2 = Promise.resolve('ok2')
    mod.instrumentFirstDataWindow(p2 as any)
    await p2
    await new Promise((r) => setTimeout(r, 0))
    expect(mod.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(true)
  })

  it('enabled path records interval after ordinaryTreeReady on resolve (one-shot, bounded, ordered)', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    ;(globalThis as any).process.env.STARTUP_STAGE_ATTR = '1'
    ;(globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC = '1'
    ;(globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV] = '1'
    const mod = await import('../startupStageDiagnostics')
    expect(mod.isStartupStageEnabled()).toBe(true)

    mod.markStartupMilestone('renderer.ordinaryTreeReady')
    const ord = mod.readStartupState().records.find((r) => r.stage === 'renderer.ordinaryTreeReady')
    expect(ord).toBeDefined()
    // small delay so interval >0
    await new Promise((r) => setTimeout(r, 5))
    const p = Promise.resolve('data')
    mod.instrumentFirstDataWindow(p as any)
    await p
    // allow then handler microtask to run
    await new Promise((r) => setTimeout(r, 0))
    const recs = mod.readStartupState().records
    const first = recs.find((r) => r.stage === 'renderer.firstData')
    expect(first).toBeDefined()
    expect(first!.status).toBe('ok')
    expect(Number.isFinite(first!.durationMs) && first!.durationMs >= 0).toBe(true)
    expect(Number.isFinite(first!.elapsedMs) && first!.elapsedMs >= 0).toBe(true)
    expect(Number.isFinite(first!.epochMs) && first!.epochMs >= 0).toBe(true)
    // ordering: firstData elapsed >= ordinaryTreeReady elapsed
    expect(first!.elapsedMs).toBeGreaterThanOrEqual(ord!.elapsedMs)
    // bounded scalar — no path separators
    expect(first!.reason === undefined || !first!.reason.includes('/')).toBe(true)
    // reason undefined or bounded
    if (first!.reason) expect(first!.reason.length).toBeLessThanOrEqual(64)
    // one-shot: second window must not add another record
    const beforeLen = recs.length
    const p2 = Promise.resolve('second')
    mod.instrumentFirstDataWindow(p2 as any)
    await p2
    await new Promise((r) => setTimeout(r, 0))
    expect(mod.readStartupState().records.filter((r) => r.stage === 'renderer.firstData').length).toBe(1)
    expect(mod.readStartupState().records.length).toBe(beforeLen)
  })

  it('records error status on rejection and remains one-shot', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    ;(globalThis as any).process.env.STARTUP_STAGE_ATTR = '1'
    ;(globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC = '1'
    ;(globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV] = '1'
    const mod = await import('../startupStageDiagnostics')
    mod.markStartupMilestone('renderer.ordinaryTreeReady')
    await new Promise((r) => setTimeout(r, 2))
    const p = Promise.reject(new Error('fail'))
    mod.instrumentFirstDataWindow(p as any)
    await p.catch(() => {})
    await new Promise((r) => setTimeout(r, 0))
    const first = mod.readStartupState().records.find((r) => r.stage === 'renderer.firstData')
    expect(first).toBeDefined()
    expect(first!.status).toBe('error')
    // second success must not overwrite
    const p2 = Promise.resolve('ok')
    mod.instrumentFirstDataWindow(p2 as any)
    await p2
    await new Promise((r) => setTimeout(r, 0))
    expect(mod.readStartupState().records.filter((r) => r.stage === 'renderer.firstData').length).toBe(1)
    expect(mod.readStartupState().records.find((r) => r.stage === 'renderer.firstData')!.status).toBe('error')
  })

  it('direct markFirstDataSettlement is one-shot and fail-closed without ready', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    ;(globalThis as any).process.env.STARTUP_STAGE_ATTR = '1'
    ;(globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC = '1'
    ;(globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV] = '1'
    const mod = await import('../startupStageDiagnostics')
    // without ready, direct mark fails
    expect(mod.markFirstDataSettlement('ok')).toBe(false)
    expect(mod.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
    mod.markStartupMilestone('renderer.ordinaryTreeReady')
    expect(mod.markFirstDataSettlement('ok')).toBe(true)
    expect(mod.markFirstDataSettlement('ok')).toBe(false) // second false
    expect(mod.readStartupState().records.filter((r) => r.stage === 'renderer.firstData').length).toBe(1)
  })

  it('reset clears firstData state when VITEST (isolated)', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    ;(globalThis as any).process.env.STARTUP_STAGE_ATTR = '1'
    ;(globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC = '1'
    ;(globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV] = '1'
    const mod = await import('../startupStageDiagnostics')
    mod.markStartupMilestone('renderer.ordinaryTreeReady')
    const p = Promise.resolve('x')
    mod.instrumentFirstDataWindow(p as any)
    await p
    await new Promise((r) => setTimeout(r, 0))
    expect(mod.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(true)
    mod.resetStartupState()
    expect(mod.readStartupState().records.length).toBe(0)
    // after reset, can record again
    mod.markStartupMilestone('renderer.ordinaryTreeReady')
    mod.markFirstDataSettlement('ok')
    expect(mod.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(true)
  })

  it('hasOrdinaryTreeReady and canRecordFirstDataNow reflect lifecycle (fail-closed)', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    ;(globalThis as any).process.env.STARTUP_STAGE_ATTR = '1'
    ;(globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC = '1'
    ;(globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV] = '1'
    const mod = await import('../startupStageDiagnostics')
    expect(mod.hasOrdinaryTreeReady()).toBe(false)
    expect(mod.canRecordFirstDataNow()).toBe(false)
    mod.markStartupMilestone('renderer.ordinaryTreeReady')
    expect(mod.hasOrdinaryTreeReady()).toBe(true)
    expect(mod.canRecordFirstDataNow()).toBe(true)
    mod.markFirstDataSettlement('ok')
    expect(mod.canRecordFirstDataNow()).toBe(false)
    // reset clears
    mod.resetStartupState()
    expect(mod.hasOrdinaryTreeReady()).toBe(false)
  })

  it('settlement-time eligibility predicate discards stale/no-topic without attribution', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    ;(globalThis as any).process.env.STARTUP_STAGE_ATTR = '1'
    ;(globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC = '1'
    ;(globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV] = '1'
    const mod = await import('../startupStageDiagnostics')
    mod.markStartupMilestone('renderer.ordinaryTreeReady')
    let eligible = true
    const pStale = new Promise<string>((resolve) => setTimeout(() => resolve('stale'), 10))
    mod.instrumentFirstDataWindow(pStale as any, () => eligible)
    // Flip to ineligible before settlement (simulates topic moved / no-topic)
    eligible = false
    await pStale
    await new Promise((r) => setTimeout(r, 0))
    expect(mod.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
    // Next eligible window should still record exactly once
    eligible = true
    const pOk = Promise.resolve('ok')
    mod.instrumentFirstDataWindow(pOk as any, () => eligible)
    await pOk
    await new Promise((r) => setTimeout(r, 0))
    expect(mod.readStartupState().records.filter((r) => r.stage === 'renderer.firstData').length).toBe(1)
    // Rejection predicate also discards
    const mod2 = await import('../startupStageDiagnostics')
    // already recorded once, so new instrument must be no-op (one-shot)
    const pReject = Promise.reject(new Error('fail'))
    mod2.instrumentFirstDataWindow(pReject as any, () => true)
    await pReject.catch(() => {})
    await new Promise((r) => setTimeout(r, 0))
    expect(mod2.readStartupState().records.filter((r) => r.stage === 'renderer.firstData').length).toBe(1)
  })

  it('instrument with predicate false on rejection also discards', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    ;(globalThis as any).process.env.STARTUP_STAGE_ATTR = '1'
    ;(globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC = '1'
    ;(globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV] = '1'
    const mod = await import('../startupStageDiagnostics')
    mod.markStartupMilestone('renderer.ordinaryTreeReady')
    const p = Promise.reject(new Error('fail'))
    mod.instrumentFirstDataWindow(p as any, () => false)
    await p.catch(() => {})
    await new Promise((r) => setTimeout(r, 0))
    expect(mod.readStartupState().records.some((r) => r.stage === 'renderer.firstData')).toBe(false)
  })
})
