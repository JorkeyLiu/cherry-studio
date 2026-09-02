import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { STARTUP_STAGE_VALIDATED_ENV } from '@shared/diagnostics/startupStage'

describe('Main startupStageDiagnostics — fail-closed and error propagation', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    // clear env
    delete process.env.STARTUP_STAGE_ATTR
    delete process.env.STARTUP_STAGE_SYNTHETIC
    delete (process.env as Record<string, string | undefined>)[STARTUP_STAGE_VALIDATED_ENV]
    // stub build define to disabled by default
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'false')
  })

  it('remains inert with default build/runtime (plain/default build leaves zero records)', async () => {
    // default: build false, runtime unset => inert
    const mod = await import('../startupStageDiagnostics')
    expect(mod.isStartupStageEnabled()).toBe(false)
    const state = mod.readStartupState()
    expect(state.records.length).toBe(0)
    // withStartupStage should run fn without recording and preserve return
    const result = await mod.withStartupStage('main.restore', async () => 'ok-value')
    expect(result).toBe('ok-value')
    expect(mod.readStartupState().records.length).toBe(0)
  })

  it('fail-closed on malformed runtime gate (no accidental partial enablement)', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    process.env.STARTUP_STAGE_ATTR = 'bad-value'
    process.env.STARTUP_STAGE_SYNTHETIC = '1'
    const mod = await import('../startupStageDiagnostics')
    // malformed runtime gate should be fail-closed => enabled false
    expect(mod.isStartupStageEnabled()).toBe(false)
    expect(mod.readStartupState().records.length).toBe(0)
  })

  it('fail-closed on malformed synthetic gate', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    process.env.STARTUP_STAGE_ATTR = '1'
    process.env.STARTUP_STAGE_SYNTHETIC = 'yes'
    const mod = await import('../startupStageDiagnostics')
    expect(mod.isStartupStageEnabled()).toBe(false)
  })

  it('synthetic-profile-gated: build+runtime true but synthetic missing => inert', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    process.env.STARTUP_STAGE_ATTR = '1'
    // synthetic not set and mock disposable path not set — should be inert
    vi.doMock('electron', () => ({
      app: { getPath: vi.fn(() => '/mock/userData') },
      ipcMain: { handle: vi.fn() }
    }))
    const mod = await import('../startupStageDiagnostics')
    expect(mod.isStartupStageEnabled()).toBe(false)
    await mod.withStartupStage('main.chatDbInit', async () => {})
    expect(mod.readStartupState().records.length).toBe(0)
  })

  it('propagates errors and records error status without changing control flow', async () => {
    // Enable fully for this test
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    process.env.STARTUP_STAGE_ATTR = '1'
    process.env.STARTUP_STAGE_SYNTHETIC = '1'
    // Mock app.getPath to satisfy synthetic heuristic alternative, but synthetic env already true
    vi.mock('electron', () => ({
      app: { getPath: vi.fn(() => '/tmp/cherry-e2e-abc/userData') },
      ipcMain: { handle: vi.fn() }
    }))
    const mod = await import('../startupStageDiagnostics')
    // Should be enabled now (build true + runtime 1 + synthetic 1)
    expect(mod.isStartupStageEnabled()).toBe(true)

    await expect(
      mod.withStartupStage('main.restore', async () => {
        throw new Error('fail')
      })
    ).rejects.toThrow('fail')
    // Should have recorded one error record
    const state = mod.readStartupState()
    expect(state.records.some((r) => r.stage === 'main.restore' && r.status === 'error')).toBe(true)

    // Second call to same stage should not double-record (dedup)
    await mod.withStartupStage('main.restore', async () => 'second')
    expect(state.records.filter((r) => r.stage === 'main.restore').length).toBe(1)

    // Success wrapper records ok
    await mod.withStartupStage('main.cleanupExtractions', async () => {})
    expect(state.records.some((r) => r.stage === 'main.cleanupExtractions' && r.status === 'ok')).toBe(true)
  })

  it('preserves ordering of sequential stages and returns values', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    process.env.STARTUP_STAGE_ATTR = 'true'
    process.env.STARTUP_STAGE_SYNTHETIC = 'true'
    vi.mock('electron', () => ({
      app: { getPath: vi.fn(() => '/tmp/cherry-e2e-x') },
      ipcMain: { handle: vi.fn() }
    }))
    const mod = await import('../startupStageDiagnostics')
    expect(mod.isStartupStageEnabled()).toBe(true)
    const order: string[] = []
    await mod.withStartupStage('main.promotionGate', async () => {
      order.push('promotionGate')
      return 1
    })
    await mod.withStartupStage('main.chatDbInit', async () => {
      order.push('chatDbInit')
      return 2
    })
    expect(order).toEqual(['promotionGate', 'chatDbInit'])
    const stages = mod.readStartupState().records.map((r) => r.stage)
    expect(stages.indexOf('main.promotionGate')).toBeLessThan(stages.indexOf('main.chatDbInit'))
  })

  it('Main marker set only after positive exact validation — externally supplied marker cannot enable without Main validation', async () => {
    // Externally supplied marker before import must be cleared and not enable
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    process.env.STARTUP_STAGE_ATTR = '1'
    process.env.STARTUP_STAGE_SYNTHETIC = '1'
    // Inject external marker before module load — should be cleared
    ;(process.env as Record<string, string | undefined>)[STARTUP_STAGE_VALIDATED_ENV] = '1'
    vi.doMock('electron', () => ({
      app: { getPath: vi.fn(() => '/mock/userData-non-disposable') },
      ipcMain: { handle: vi.fn() }
    }))
    // Temporarily disable VITEST bypass to force exact validation path
    const origVitest = process.env.VITEST
    delete process.env.VITEST
    const mod = await import('../startupStageDiagnostics')
    // Validation should fail (non-disposable path) => disabled and marker cleared
    expect(mod.isStartupStageEnabled()).toBe(false)
    expect(process.env[STARTUP_STAGE_VALIDATED_ENV]).toBeUndefined()
    // Restore VITEST for other tests
    if (origVitest !== undefined) process.env.VITEST = origVitest
    else process.env.VITEST = 'true'
  })

  it('Main fail-closed on filesystem validation uncertainty (realpath/lstat failure disables)', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    process.env.STARTUP_STAGE_ATTR = '1'
    process.env.STARTUP_STAGE_SYNTHETIC = '1'
    const origVitest = process.env.VITEST
    delete process.env.VITEST
    const origTmpdir = process.env.TMPDIR
    const origTmp = process.env.TMP
    const origTemp = process.env.TEMP
    let ownedReal: string | null = null
    try {
      const canonicalParent = fs.realpathSync(os.tmpdir())
      const ownedRoot = fs.mkdtempSync(path.join(canonicalParent, 'cherry-e2e-owned-'))
      ownedReal = fs.realpathSync(ownedRoot)
      const token = `cherry-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const profile = path.join(ownedReal, token)
      fs.mkdirSync(profile, { recursive: true })
      const profileReal = fs.realpathSync(profile)
      process.env.TMPDIR = ownedReal
      process.env.TMP = ownedReal
      process.env.TEMP = ownedReal
      // Mock os.tmpdir to return ownedReal for the exact-validation path
      const ownedForMock = ownedReal
      vi.doMock('node:os', async () => {
        const actual: any = await vi.importActual('node:os')
        const mocked = { ...actual, tmpdir: () => ownedForMock }
        if (actual.default) mocked.default = { ...actual.default, tmpdir: () => ownedForMock }
        return mocked
      })
      // Mock fs to throw on realpath/lstat to simulate uncertainty
      vi.doMock('node:fs', async () => {
        const actual: any = await vi.importActual('node:fs')
        return {
          ...actual,
          realpathSync: () => {
            throw new Error('ENOENT')
          },
          lstatSync: () => {
            throw new Error('ENOENT')
          },
          default: {
            ...actual.default,
            realpathSync: () => {
              throw new Error('ENOENT')
            },
            lstatSync: () => {
              throw new Error('ENOENT')
            }
          }
        }
      })
      vi.doMock('electron', () => ({
        app: { getPath: vi.fn(() => profileReal) },
        ipcMain: { handle: vi.fn() }
      }))
      const mod = await import('../startupStageDiagnostics')
      expect(mod.isStartupStageEnabled()).toBe(false)
      expect(process.env[STARTUP_STAGE_VALIDATED_ENV]).toBeUndefined()
    } finally {
      if (ownedReal && fs.existsSync(ownedReal)) {
        try {
          // restore fs mock by unmocking for cleanup
          vi.doUnmock('node:fs')
          const realFs: any = await vi.importActual('node:fs')
          if (realFs.existsSync(ownedReal)) realFs.rmSync(ownedReal, { recursive: true, force: true })
        } catch {}
        try {
          if (fs.existsSync(ownedReal)) fs.rmSync(ownedReal, { recursive: true, force: true })
        } catch {}
      }
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir
      else delete process.env.TMPDIR
      if (origTmp !== undefined) process.env.TMP = origTmp
      else delete process.env.TMP
      if (origTemp !== undefined) process.env.TEMP = origTemp
      else delete process.env.TEMP
      if (origVitest !== undefined) process.env.VITEST = origVitest
      else process.env.VITEST = 'true'
      vi.doUnmock('node:fs')
      vi.doUnmock('node:os')
    }
  })

  it('Main marker set only after positive exact validation (VITEST bypass also sets marker)', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    process.env.STARTUP_STAGE_ATTR = '1'
    process.env.STARTUP_STAGE_SYNTHETIC = '1'
    vi.mock('electron', () => ({
      app: { getPath: vi.fn(() => '/tmp/cherry-e2e-abc/userData') },
      ipcMain: { handle: vi.fn() }
    }))
    const mod = await import('../startupStageDiagnostics')
    expect(mod.isStartupStageEnabled()).toBe(true)
    // Marker must be set after positive validation (VITEST path)
    expect(process.env[STARTUP_STAGE_VALIDATED_ENV]).toBe('1')
  })

  it('valid fixture topology <owned-root>/<profile> when TMPDIR is owned root positively validates (exact canonical real paths)', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    process.env.STARTUP_STAGE_ATTR = '1'
    process.env.STARTUP_STAGE_SYNTHETIC = '1'
    const origVitest = process.env.VITEST
    delete process.env.VITEST
    const origTmpdir = process.env.TMPDIR
    const origTmp = process.env.TMP
    const origTemp = process.env.TEMP
    let ownedReal: string | null = null
    try {
      const canonicalParent = fs.realpathSync(os.tmpdir())
      const ownedRoot = fs.mkdtempSync(path.join(canonicalParent, 'cherry-e2e-owned-'))
      ownedReal = fs.realpathSync(ownedRoot)
      const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const profile = path.join(ownedReal, `cherry-e2e-${token}`)
      fs.mkdirSync(profile, { recursive: true })
      const profileReal = fs.realpathSync(profile)
      process.env.TMPDIR = ownedReal
      process.env.TMP = ownedReal
      process.env.TEMP = ownedReal
      const ownedForMock = ownedReal
      vi.doMock('node:os', async () => {
        const actual: any = await vi.importActual('node:os')
        const mocked = { ...actual, tmpdir: () => ownedForMock }
        if (actual.default) mocked.default = { ...actual.default, tmpdir: () => ownedForMock }
        return mocked
      })
      vi.doMock('electron', () => ({
        app: { getPath: vi.fn(() => profileReal) },
        ipcMain: { handle: vi.fn() }
      }))
      const mod = await import('../startupStageDiagnostics')
      expect(mod.isStartupStageEnabled()).toBe(true)
      expect(process.env[STARTUP_STAGE_VALIDATED_ENV]).toBe('1')
      const state = mod.readStartupState()
      expect(state.enabled).toBe(true)
    } finally {
      vi.doUnmock('node:os')
      if (ownedReal && fs.existsSync(ownedReal)) {
        fs.rmSync(ownedReal, { recursive: true, force: true })
      }
      if (origVitest !== undefined) process.env.VITEST = origVitest
      else process.env.VITEST = 'true'
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir
      else delete process.env.TMPDIR
      if (origTmp !== undefined) process.env.TMP = origTmp
      else delete process.env.TMP
      if (origTemp !== undefined) process.env.TEMP = origTemp
      else delete process.env.TEMP
    }
  })

  it('outside-root profile remains disabled (fail-closed)', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    process.env.STARTUP_STAGE_ATTR = '1'
    process.env.STARTUP_STAGE_SYNTHETIC = '1'
    const origVitest = process.env.VITEST
    delete process.env.VITEST
    const origTmpdir = process.env.TMPDIR
    const origTmp = process.env.TMP
    const origTemp = process.env.TEMP
    let ownedReal: string | null = null
    let outsideDir: string | null = null
    try {
      const canonicalParent = fs.realpathSync(os.tmpdir())
      const ownedRoot = fs.mkdtempSync(path.join(canonicalParent, 'cherry-e2e-owned-'))
      ownedReal = fs.realpathSync(ownedRoot)
      const outsideToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      outsideDir = path.join(canonicalParent, `cherry-e2e-${outsideToken}`)
      fs.mkdirSync(outsideDir, { recursive: true })
      const outsideReal = fs.realpathSync(outsideDir)
      process.env.TMPDIR = ownedReal
      process.env.TMP = ownedReal
      process.env.TEMP = ownedReal
      const ownedForMock = ownedReal
      vi.doMock('node:os', async () => {
        const actual: any = await vi.importActual('node:os')
        const mocked = { ...actual, tmpdir: () => ownedForMock }
        if (actual.default) mocked.default = { ...actual.default, tmpdir: () => ownedForMock }
        return mocked
      })
      vi.doMock('electron', () => ({
        app: { getPath: vi.fn(() => outsideReal) },
        ipcMain: { handle: vi.fn() }
      }))
      const mod = await import('../startupStageDiagnostics')
      expect(mod.isStartupStageEnabled()).toBe(false)
      expect(process.env[STARTUP_STAGE_VALIDATED_ENV]).toBeUndefined()
    } finally {
      vi.doUnmock('node:os')
      if (ownedReal && fs.existsSync(ownedReal)) fs.rmSync(ownedReal, { recursive: true, force: true })
      if (outsideDir && fs.existsSync(outsideDir)) fs.rmSync(outsideDir, { recursive: true, force: true })
      if (origVitest !== undefined) process.env.VITEST = origVitest
      else process.env.VITEST = 'true'
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir
      else delete process.env.TMPDIR
      if (origTmp !== undefined) process.env.TMP = origTmp
      else delete process.env.TMP
      if (origTemp !== undefined) process.env.TEMP = origTemp
      else delete process.env.TEMP
    }
  })

  it('symlink profile remains disabled (fail-closed, non-symlink required)', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    process.env.STARTUP_STAGE_ATTR = '1'
    process.env.STARTUP_STAGE_SYNTHETIC = '1'
    const origVitest = process.env.VITEST
    delete process.env.VITEST
    const origTmpdir = process.env.TMPDIR
    const origTmp = process.env.TMP
    const origTemp = process.env.TEMP
    let ownedReal: string | null = null
    try {
      const canonicalParent = fs.realpathSync(os.tmpdir())
      const ownedRoot = fs.mkdtempSync(path.join(canonicalParent, 'cherry-e2e-owned-'))
      ownedReal = fs.realpathSync(ownedRoot)
      const target = path.join(ownedReal, `cherry-e2e-target-${Date.now()}`)
      fs.mkdirSync(target, { recursive: true })
      const targetReal = fs.realpathSync(target)
      const linkPath = path.join(ownedReal, `cherry-e2e-link-${Date.now()}`)
      fs.symlinkSync(targetReal, linkPath, 'dir')
      process.env.TMPDIR = ownedReal
      process.env.TMP = ownedReal
      process.env.TEMP = ownedReal
      const ownedForMock = ownedReal
      vi.doMock('node:os', async () => {
        const actual: any = await vi.importActual('node:os')
        const mocked = { ...actual, tmpdir: () => ownedForMock }
        if (actual.default) mocked.default = { ...actual.default, tmpdir: () => ownedForMock }
        return mocked
      })
      vi.doMock('electron', () => ({
        app: { getPath: vi.fn(() => linkPath) },
        ipcMain: { handle: vi.fn() }
      }))
      const mod = await import('../startupStageDiagnostics')
      expect(mod.isStartupStageEnabled()).toBe(false)
      expect(process.env[STARTUP_STAGE_VALIDATED_ENV]).toBeUndefined()
    } finally {
      vi.doUnmock('node:os')
      if (ownedReal && fs.existsSync(ownedReal)) fs.rmSync(ownedReal, { recursive: true, force: true })
      if (origVitest !== undefined) process.env.VITEST = origVitest
      else process.env.VITEST = 'true'
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir
      else delete process.env.TMPDIR
      if (origTmp !== undefined) process.env.TMP = origTmp
      else delete process.env.TMP
      if (origTemp !== undefined) process.env.TEMP = origTemp
      else delete process.env.TEMP
    }
  })

  it('malformed profile path with .. segment remains disabled', async () => {
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'true')
    process.env.STARTUP_STAGE_ATTR = '1'
    process.env.STARTUP_STAGE_SYNTHETIC = '1'
    const origVitest = process.env.VITEST
    delete process.env.VITEST
    try {
      vi.doMock('node:os', async () => {
        const actual: any = await vi.importActual('node:os')
        const mocked = { ...actual, tmpdir: () => '/tmp' }
        if (actual.default) mocked.default = { ...actual.default, tmpdir: () => '/tmp' }
        return mocked
      })
      vi.doMock('electron', () => ({
        app: { getPath: vi.fn(() => '/tmp/cherry-e2e-owned-abc/../etc/passwd') },
        ipcMain: { handle: vi.fn() }
      }))
      const mod = await import('../startupStageDiagnostics')
      expect(mod.isStartupStageEnabled()).toBe(false)
      expect(process.env[STARTUP_STAGE_VALIDATED_ENV]).toBeUndefined()
    } finally {
      vi.doUnmock('node:os')
      if (origVitest !== undefined) process.env.VITEST = origVitest
      else process.env.VITEST = 'true'
    }
  })
})
