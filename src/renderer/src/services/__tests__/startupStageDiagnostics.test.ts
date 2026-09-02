import { STARTUP_STAGE_VALIDATED_ENV } from '@shared/diagnostics/startupStage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('Renderer startupStageDiagnostics — gates and bounded milestones', () => {
  beforeEach(() => {
    vi.resetModules()
    delete (globalThis as any).process?.env?.STARTUP_STAGE_ATTR
    delete (globalThis as any).process?.env?.STARTUP_STAGE_SYNTHETIC
    delete (globalThis as any).process?.env?.[STARTUP_STAGE_VALIDATED_ENV]
    if (!(globalThis as any).process) (globalThis as any).process = { env: {} }
    delete (globalThis as any).process.env.STARTUP_STAGE_ATTR
    delete (globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC
    delete (globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV]
    // reset window.electron
    ;(globalThis as any).window = {}
    if ((globalThis as any).window?.electron?.process?.env) {
      delete (globalThis as any).window.electron.process.env[STARTUP_STAGE_VALIDATED_ENV]
    }
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'false')
  })

  it('inert by default (plain build leaves zero records)', async () => {
    const mod = await import('../startupStageDiagnostics')
    expect(mod.isStartupStageEnabled()).toBe(false)
    mod.markStartupMilestone('renderer.bootstrap')
    expect(mod.readStartupState().records.length).toBe(0)
  })

  it('fail-closed on malformed runtime gate', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    ;(globalThis as any).process.env.STARTUP_STAGE_ATTR = 'bad'
    ;(globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC = '1'
    const mod = await import('../startupStageDiagnostics')
    expect(mod.isStartupStageEnabled()).toBe(false)
  })

  it('synthetic gate required — runtime true without synthetic stays inert', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    ;(globalThis as any).process.env.STARTUP_STAGE_ATTR = '1'
    const mod = await import('../startupStageDiagnostics')
    expect(mod.isStartupStageEnabled()).toBe(false)
    mod.markStartupMilestone('renderer.persistRehydrate')
    expect(mod.readStartupState().records.length).toBe(0)
  })

  it('enabled path records milestone and deduplicates', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    ;(globalThis as any).process.env.STARTUP_STAGE_ATTR = '1'
    ;(globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC = '1'
    ;(globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV] = '1'
    const mod = await import('../startupStageDiagnostics')
    expect(mod.isStartupStageEnabled()).toBe(true)
    mod.markStartupMilestone('renderer.bootstrap')
    mod.markStartupMilestone('renderer.bootstrap') // duplicate ignored
    expect(mod.readStartupState().records.filter((r) => r.stage === 'renderer.bootstrap').length).toBe(1)
    expect(mod.readStartupState().records[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(mod.readStartupState().records[0].epochMs)).toBe(true)
  })

  it('markStartupStage with explicit startPerf dedupes and respects enabled', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    ;(globalThis as any).process.env.STARTUP_STAGE_ATTR = 'true'
    ;(globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC = 'true'
    ;(globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV] = '1'
    const mod = await import('../startupStageDiagnostics')
    const start = performance.now()
    await new Promise((r) => setTimeout(r, 2))
    mod.markStartupStage('renderer.persistRehydrate', start)
    mod.markStartupStage('renderer.persistRehydrate', start) // second ignored
    expect(mod.readStartupState().records.filter((r) => r.stage === 'renderer.persistRehydrate').length).toBe(1)
  })

  it('reveals synthetic gate via window.electron.process.env as well', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    ;(globalThis as any).window = {
      electron: {
        process: { env: { STARTUP_STAGE_ATTR: '1', STARTUP_STAGE_SYNTHETIC: '1', [STARTUP_STAGE_VALIDATED_ENV]: '1' } }
      }
    }
    // clear process.env to force window.electron path
    delete (globalThis as any).process.env.STARTUP_STAGE_ATTR
    delete (globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV]
    const mod = await import('../startupStageDiagnostics')
    expect(mod.isStartupStageEnabled()).toBe(true)
  })

  it('renderer without Main marker disables even with synthetic tokens', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    ;(globalThis as any).process.env.STARTUP_STAGE_ATTR = '1'
    ;(globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC = '1'
    // marker NOT set — should be inert
    delete (globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV]
    const mod = await import('../startupStageDiagnostics')
    expect(mod.isStartupStageEnabled()).toBe(false)
    mod.markStartupMilestone('renderer.bootstrap')
    expect(mod.readStartupState().records.length).toBe(0)
  })

  it('renderer with marker enables only when all gates pass', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    // missing runtime gate but marker present — should still be inert
    ;(globalThis as any).process.env.STARTUP_STAGE_ATTR = ''
    ;(globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC = '1'
    ;(globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV] = '1'
    let mod = await import('../startupStageDiagnostics')
    expect(mod.isStartupStageEnabled()).toBe(false)

    vi.resetModules()
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    ;(globalThis as any).process = { env: { VITEST: 'true' } }
    ;(globalThis as any).window = {}
    ;(globalThis as any).process.env.STARTUP_STAGE_ATTR = '1'
    ;(globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC = '1'
    ;(globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV] = '1'
    mod = await import('../startupStageDiagnostics')
    expect(mod.isStartupStageEnabled()).toBe(true)
  })

  it('renderer respects marker via window.electron.process.env', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    ;(globalThis as any).window = {
      electron: {
        process: { env: { STARTUP_STAGE_ATTR: '1', STARTUP_STAGE_SYNTHETIC: '1', [STARTUP_STAGE_VALIDATED_ENV]: '1' } }
      }
    }
    if (!(globalThis as any).process) (globalThis as any).process = { env: { VITEST: 'true' } }
    else (globalThis as any).process.env.VITEST = 'true'
    delete (globalThis as any).process.env.STARTUP_STAGE_ATTR
    delete (globalThis as any).process.env.STARTUP_STAGE_SYNTHETIC
    delete (globalThis as any).process.env[STARTUP_STAGE_VALIDATED_ENV]
    const mod = await import('../startupStageDiagnostics')
    expect(mod.isStartupStageEnabled()).toBe(true)

    // Without marker via same channel should be disabled
    vi.resetModules()
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    ;(globalThis as any).window = {
      electron: { process: { env: { STARTUP_STAGE_ATTR: '1', STARTUP_STAGE_SYNTHETIC: '1' } } }
    }
    ;(globalThis as any).process = { env: { VITEST: 'true' } }
    const mod2 = await import('../startupStageDiagnostics')
    expect(mod2.isStartupStageEnabled()).toBe(false)
  })
})
