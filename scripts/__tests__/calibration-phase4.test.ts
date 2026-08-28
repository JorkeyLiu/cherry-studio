import { describe, expect, test } from 'vitest'

import {
  buildChildEnv,
  type CalibrationDeps,
  type CalibrationStep,
  getPhase4CalibrationSteps,
  isValidNpmExecPath,
  PHASE4_CALIBRATION_ALIAS,
  PHASE4_CALIBRATION_COMMAND,
  PHASE4_CALIBRATION_STEPS,
  resolvePnpmCommand,
  resolvePnpmLaunch,
  runPhase4Calibration,
  validateC02EnvIsolation,
  validateCanonicalCommands,
  validateOrderedLanes
} from '../calibration-phase4'

describe('calibration:phase4 — public command contract (LOCK-001..004)', () => {
  test('public command names are stable and documented', () => {
    expect(PHASE4_CALIBRATION_COMMAND).toBe('pnpm calibration:phase4')
    expect(PHASE4_CALIBRATION_ALIAS).toBe('pnpm bench:phase4-calibration')
  })

  test('steps length is exactly 4', () => {
    expect(getPhase4CalibrationSteps()).toHaveLength(4)
    expect(PHASE4_CALIBRATION_STEPS).toHaveLength(4)
  })

  test('ordered ids match locked sequence', () => {
    const ids = getPhase4CalibrationSteps().map((s) => s.id)
    expect(ids).toEqual(['c01-logical-payload', 'pinned-working-set', 'build', 'c02-heap-mixed'])
  })

  test('canonical public commands are used — no bypass, no shell interpolation', () => {
    const steps = getPhase4CalibrationSteps()
    expect(validateCanonicalCommands(steps)).toEqual([])
    // Explicit per-step assertions for readability
    expect(steps[0].command).toBe('pnpm')
    expect(steps[0].args).toEqual(['bench:logical-payload'])
    expect(steps[1].command).toBe('pnpm')
    expect(steps[1].args).toEqual(['bench:pinned-working-set'])
    expect(steps[2].command).toBe('pnpm')
    expect(steps[2].args).toEqual(['build'])
    expect(steps[3].command).toBe('pnpm')
    expect(steps[3].args).toEqual(['test:e2e', '--', 'tests/e2e/specs/conversation/perf-c02-heap-calibration.spec.ts'])
    // No direct native:run/vitest/playwright bypass
    for (const s of steps) {
      expect(s.command).toBe('pnpm')
      expect(s.args.join(' ')).not.toMatch(/native:run/)
      expect(s.args.join(' ')).not.toMatch(/vitest bench/)
      expect(s.args.join(' ')).not.toMatch(/playwright/)
    }
  })

  test('C02 env isolation — only final step carries C02_HEAP_CALIBRATION=mixed', () => {
    const steps = getPhase4CalibrationSteps()
    expect(validateC02EnvIsolation(steps)).toEqual([])
    expect(steps[0].env).toEqual({})
    expect(steps[1].env).toEqual({})
    expect(steps[2].env).toEqual({})
    expect(steps[3].env).toEqual({ C02_HEAP_CALIBRATION: 'mixed' })
    // Negative: moving env earlier must be rejected
    const badEarly: CalibrationStep[] = [
      { ...steps[0], env: { C02_HEAP_CALIBRATION: 'mixed' } },
      steps[1],
      steps[2],
      { ...steps[3], env: {} }
    ]
    expect(validateC02EnvIsolation(badEarly).length).toBeGreaterThan(0)
    // Negative: wrong value must be rejected
    const badValue: CalibrationStep[] = [...steps.slice(0, 3), { ...steps[3], env: { C02_HEAP_CALIBRATION: '1' } }]
    expect(validateC02EnvIsolation(badValue).length).toBeGreaterThan(0)
  })

  test('ordered lanes are Node, Node, Electron, Electron', () => {
    const steps = getPhase4CalibrationSteps()
    expect(validateOrderedLanes(steps)).toEqual([])
    expect(steps.map((s) => s.lane)).toEqual(['node', 'node', 'electron', 'electron'])
    // Negative: swapping build to node must be rejected
    const badLanes: CalibrationStep[] = [steps[0], steps[1], { ...steps[2], lane: 'node' }, steps[3]]
    expect(validateOrderedLanes(badLanes).length).toBeGreaterThan(0)
  })

  test('package.json exposes both public commands via tsx script', async () => {
    const fs = await import('node:fs')
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['calibration:phase4']).toBe('tsx scripts/calibration-phase4.ts')
    expect(pkg.scripts['bench:phase4-calibration']).toBe('tsx scripts/calibration-phase4.ts')
  })

  test('script source does not bypass lane — no manual native:rebuild or ABI switch', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync('scripts/calibration-phase4.ts', 'utf-8')
    expect(src).toContain('bench:logical-payload')
    expect(src).toContain('bench:pinned-working-set')
    expect(src).toContain("'build'")
    expect(src).toContain('perf-c02-heap-calibration.spec.ts')
    expect(src).toContain('C02_HEAP_CALIBRATION')
    // Must not manually invoke native:rebuild or directly switch ABI
    expect(src).not.toMatch(/native:rebuild/)
    expect(src).not.toMatch(/native:check/)
    // Must not use shell env prefix interpolation
    expect(src).not.toMatch(/C02_HEAP_CALIBRATION=mixed pnpm/)
    // Must use spawnSync with explicit env merging (cross-platform)
    expect(src).toContain('spawnSync')
    expect(src).toContain('env')
    // Windows launcher must be shell-free argv-based via Node + npm_execpath, not pnpm.cmd or shell
    expect(src).not.toMatch(/pnpm\.cmd/)
    expect(src).not.toMatch(/shell\s*:\s*true/)
    expect(src).not.toMatch(/execFile.*shell/)
    expect(src).not.toMatch(/cmd\.exe/)
    expect(src).toContain('npm_execpath')
    expect(src).toContain('npmExecPath')
    expect(src).toContain('execPath')
    expect(src).toContain('resolvePnpmLaunch')
  })

  test('steps preserve independent schema-v1 artifact classes — ids are distinct', () => {
    // Artifacts are documented via step descriptions; ensure they reference the 3 independent ids
    const descs = getPhase4CalibrationSteps().map((s) => s.description)
    expect(descs[0]).toMatch(/logical-retained-payload-calibration/)
    expect(descs[1]).toMatch(/pinned-working-set-calibration/)
    expect(descs[3]).toMatch(/chatdb-c02-renderer-heap-e2e/)
    // Build step has no calibration artifact
    expect(descs[2].toLowerCase()).toMatch(/production build/)
  })
})

describe('calibration:phase4 — fail-closed execution (deterministic, injected)', () => {
  function makeDeps(
    overrides: Partial<CalibrationDeps> & {
      statuses: Array<number | null>
      signals?: Array<NodeJS.Signals | null>
      errors?: Array<Error | undefined>
    }
  ): CalibrationDeps & { calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> } {
    const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = []
    let idx = 0
    const deps: CalibrationDeps & { calls: typeof calls } = {
      spawnSyncFn: (command, args, options) => {
        calls.push({ command, args, env: options.env })
        const status = overrides.statuses[idx] ?? 0
        const signal = overrides.signals?.[idx] ?? null
        const error = overrides.errors?.[idx]
        idx++
        if (error) return { status: null, error }
        if (signal) return { status: null, signal }
        return { status, signal: null }
      },
      env: { PATH: '/usr/bin', HOME: '/tmp', ...overrides.env } as NodeJS.ProcessEnv,
      stdout: () => {},
      stderr: () => {},
      calls
    }
    return deps
  }

  test('happy path runs all 4 steps and returns 0, env merged cross-platform only on final step', () => {
    const deps = makeDeps({ statuses: [0, 0, 0, 0], env: { PATH: '/usr/bin', EXISTING: 'keep' } })
    const result = runPhase4Calibration(undefined, deps)
    expect(result.exitCode).toBe(0)
    expect(result.failedStepId).toBeNull()
    expect(deps.calls).toHaveLength(4)
    // First three steps have no C02 env
    expect(deps.calls[0].env.C02_HEAP_CALIBRATION).toBeUndefined()
    expect(deps.calls[1].env.C02_HEAP_CALIBRATION).toBeUndefined()
    expect(deps.calls[2].env.C02_HEAP_CALIBRATION).toBeUndefined()
    // Final step merges env cross-platform (not shell prefix)
    expect(deps.calls[3].env.C02_HEAP_CALIBRATION).toBe('mixed')
    // Base env preserved
    expect(deps.calls[3].env.EXISTING).toBe('keep')
    expect(deps.calls[3].env.PATH).toBe('/usr/bin')
    // Commands are canonical
    expect(deps.calls[0].command).toBe('pnpm')
    expect(deps.calls[0].args).toEqual(['bench:logical-payload'])
    expect(deps.calls[3].args).toEqual([
      'test:e2e',
      '--',
      'tests/e2e/specs/conversation/perf-c02-heap-calibration.spec.ts'
    ])
  })

  test('fail-closed: C-01 failure aborts remaining steps', () => {
    const deps = makeDeps({ statuses: [2, 0, 0, 0] })
    const result = runPhase4Calibration(undefined, deps)
    expect(result.exitCode).toBe(2)
    expect(result.failedStepId).toBe('c01-logical-payload')
    expect(deps.calls).toHaveLength(1)
  })

  test('fail-closed: pinned failure aborts build and C-02', () => {
    const deps = makeDeps({ statuses: [0, 5, 0, 0] })
    const result = runPhase4Calibration(undefined, deps)
    expect(result.exitCode).toBe(5)
    expect(result.failedStepId).toBe('pinned-working-set')
    expect(deps.calls).toHaveLength(2)
  })

  test('fail-closed: build failure aborts C-02', () => {
    const deps = makeDeps({ statuses: [0, 0, 7, 0] })
    const result = runPhase4Calibration(undefined, deps)
    expect(result.exitCode).toBe(7)
    expect(result.failedStepId).toBe('build')
    expect(deps.calls).toHaveLength(3)
  })

  test('fail-closed: C-02 mixed failure propagates', () => {
    const deps = makeDeps({ statuses: [0, 0, 0, 3] })
    const result = runPhase4Calibration(undefined, deps)
    expect(result.exitCode).toBe(3)
    expect(result.failedStepId).toBe('c02-heap-mixed')
    expect(deps.calls).toHaveLength(4)
  })

  test('spawn error is fail-closed as 1', () => {
    // error on second call
    const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = []
    let idx = 0
    const customDeps: CalibrationDeps & { calls: typeof calls } = {
      spawnSyncFn: (command, args, options) => {
        calls.push({ command, args, env: options.env })
        if (idx === 1) {
          idx++
          return { status: null, error: new Error('spawn ENOENT') }
        }
        idx++
        return { status: 0, signal: null }
      },
      env: process.env,
      stdout: () => {},
      stderr: () => {},
      calls
    }
    const result = runPhase4Calibration(undefined, customDeps)
    expect(result.exitCode).toBe(1)
    expect(result.failedStepId).toBe('pinned-working-set')
    expect(customDeps.calls).toHaveLength(2)
  })

  test('signal termination is fail-closed as 1', () => {
    const deps = makeDeps({ statuses: [0, 0, 0, 0], signals: [null, null, 'SIGTERM' as NodeJS.Signals] })
    const result = runPhase4Calibration(undefined, deps)
    expect(result.exitCode).toBe(1)
    expect(result.failedStepId).toBe('build')
    expect(deps.calls).toHaveLength(3)
  })

  test('null status without signal/error is fail-closed as 1', () => {
    const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = []
    let idx = 0
    const deps: CalibrationDeps & { calls: typeof calls } = {
      spawnSyncFn: (command, args, options) => {
        calls.push({ command, args, env: options.env })
        if (idx === 0) {
          idx++
          return { status: null, signal: null }
        }
        idx++
        return { status: 0, signal: null }
      },
      env: process.env,
      stdout: () => {},
      stderr: () => {},
      calls
    }
    const result = runPhase4Calibration(undefined, deps)
    expect(result.exitCode).toBe(1)
    expect(result.failedStepId).toBe('c01-logical-payload')
    expect(calls).toHaveLength(1)
  })

  test('thrown spawn exception is fail-closed as 1', () => {
    const deps: CalibrationDeps = {
      spawnSyncFn: () => {
        throw new Error('thrown')
      },
      env: process.env,
      stdout: () => {},
      stderr: () => {}
    }
    const result = runPhase4Calibration(undefined, deps)
    expect(result.exitCode).toBe(1)
    expect(result.failedStepId).toBe('c01-logical-payload')
  })

  test('contract violation fails before spawning (wrong steps)', () => {
    const badSteps: CalibrationStep[] = [
      {
        id: 'c01-logical-payload',
        command: 'pnpm',
        args: ['bench:logical-payload'],
        env: {},
        lane: 'node',
        description: ''
      },
      {
        id: 'pinned-working-set',
        command: 'pnpm',
        args: ['bench:pinned-working-set'],
        env: { C02_HEAP_CALIBRATION: 'mixed' },
        lane: 'node',
        description: ''
      },
      { id: 'build', command: 'pnpm', args: ['build'], env: {}, lane: 'electron', description: '' },
      {
        id: 'c02-heap-mixed',
        command: 'pnpm',
        args: ['test:e2e', '--', 'tests/e2e/specs/conversation/perf-c02-heap-calibration.spec.ts'],
        env: {},
        lane: 'electron',
        description: ''
      }
    ]
    let spawned = false
    const deps: CalibrationDeps = {
      spawnSyncFn: () => {
        spawned = true
        return { status: 0, signal: null }
      },
      env: process.env,
      stdout: () => {},
      stderr: () => {}
    }
    const result = runPhase4Calibration(badSteps, deps)
    expect(result.exitCode).toBe(1)
    expect(result.failedStepId).toBe('__contract__')
    expect(spawned).toBe(false)
  })
})

describe('calibration:phase4 — ambient C02 env leakage correction (focused)', () => {
  test('buildChildEnv strips ambient C02 for non-final and forces mixed for final', () => {
    const ambientValues = ['polluted', '1', 'mixed', 'should-not-leak', '']
    for (const ambient of ambientValues) {
      const parent = { PATH: '/usr/bin', C02_HEAP_CALIBRATION: ambient } as NodeJS.ProcessEnv
      const nonFinal = buildChildEnv(parent, {}, false)
      expect(nonFinal.C02_HEAP_CALIBRATION).toBeUndefined()
      expect(nonFinal.PATH).toBe('/usr/bin')
      // should not mutate parent
      expect(parent.C02_HEAP_CALIBRATION).toBe(ambient)

      const final = buildChildEnv(parent, {}, true)
      expect(final.C02_HEAP_CALIBRATION).toBe('mixed')
      expect(final.PATH).toBe('/usr/bin')
    }
  })

  test('buildChildEnv non-final strips step-provided C02 as well', () => {
    const parent = { PATH: '/usr/bin', C02_HEAP_CALIBRATION: 'ambient' } as NodeJS.ProcessEnv
    const stepEnv = { C02_HEAP_CALIBRATION: 'mixed' } as Readonly<Record<string, string>>
    const nonFinal = buildChildEnv(parent, stepEnv, false)
    expect(nonFinal.C02_HEAP_CALIBRATION).toBeUndefined()
  })

  test('buildChildEnv final forces mixed even when ambient and step have different values', () => {
    const parent = { C02_HEAP_CALIBRATION: 'stale', EXTRA: 'keep' } as NodeJS.ProcessEnv
    const stepEnv = { C02_HEAP_CALIBRATION: 'wrong' } as Readonly<Record<string, string>>
    const final = buildChildEnv(parent, stepEnv, true)
    expect(final.C02_HEAP_CALIBRATION).toBe('mixed')
    expect(final.EXTRA).toBe('keep')
  })

  test('runPhase4Calibration does not inherit ambient C02 into first three envs, final is exactly mixed', () => {
    const ambientEnvs = [
      { C02_HEAP_CALIBRATION: 'polluted', EXISTING: 'keep' },
      { C02_HEAP_CALIBRATION: 'mixed', PATH: '/bin' },
      { C02_HEAP_CALIBRATION: '1' },
      { C02_HEAP_CALIBRATION: '' }
    ]
    for (const ambient of ambientEnvs) {
      const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = []
      const deps: CalibrationDeps = {
        spawnSyncFn: (command, args, options) => {
          calls.push({ command, args, env: options.env })
          return { status: 0, signal: null }
        },
        env: { PATH: '/usr/bin', ...ambient } as NodeJS.ProcessEnv,
        stdout: () => {},
        stderr: () => {}
      }
      const result = runPhase4Calibration(undefined, deps)
      expect(result.exitCode).toBe(0)
      expect(calls).toHaveLength(4)
      // ambient must not leak to steps 0-2
      expect(calls[0].env.C02_HEAP_CALIBRATION).toBeUndefined()
      expect(calls[1].env.C02_HEAP_CALIBRATION).toBeUndefined()
      expect(calls[2].env.C02_HEAP_CALIBRATION).toBeUndefined()
      // final must be exactly mixed, overriding ambient
      expect(calls[3].env.C02_HEAP_CALIBRATION).toBe('mixed')
      // base env preserved
      expect(calls[3].env.PATH).toBeDefined()
      // ensure first three still retain base keys
      expect(calls[0].env.PATH).toBeDefined()
      expect('C02_HEAP_CALIBRATION' in calls[0].env).toBe(false)
      expect('C02_HEAP_CALIBRATION' in calls[1].env).toBe(false)
      expect('C02_HEAP_CALIBRATION' in calls[2].env).toBe(false)
      expect('C02_HEAP_CALIBRATION' in calls[3].env).toBe(true)
    }
  })
})

describe('calibration:phase4 — cross-platform pnpm launcher correction (focused)', () => {
  test('resolvePnpmCommand remains shell-free pnpm for all platforms (pnpm.cmd removed)', () => {
    expect(resolvePnpmCommand('win32')).toBe('pnpm')
    expect(resolvePnpmCommand('darwin')).toBe('pnpm')
    expect(resolvePnpmCommand('linux')).toBe('pnpm')
    expect(resolvePnpmCommand('freebsd')).toBe('pnpm')
  })

  test('resolvePnpmLaunch is platform-targeted and argv-safe without host requirement', () => {
    const canonical: readonly string[] = ['bench:logical-payload']
    const execPath = '/fake/node'
    const npmExecPath = '/fake/pnpm/dist/pnpm.cjs'

    // win32 with valid entry resolves to Node executable + entry + args
    const winLaunch = resolvePnpmLaunch('win32', execPath, npmExecPath, canonical)
    expect('error' in winLaunch).toBe(false)
    if (!('error' in winLaunch)) {
      expect(winLaunch.command).toBe(execPath)
      expect(winLaunch.args).toEqual([npmExecPath, ...canonical])
      expect(Array.isArray(winLaunch.args)).toBe(true)
    }

    // POSIX keeps direct pnpm with unchanged args
    for (const plat of ['darwin', 'linux', 'freebsd']) {
      const posix = resolvePnpmLaunch(plat, execPath, npmExecPath, canonical)
      expect('error' in posix).toBe(false)
      if (!('error' in posix)) {
        expect(posix.command).toBe('pnpm')
        expect(posix.args).toEqual(canonical)
      }
    }

    // isValidNpmExecPath helper mirrors validation
    expect(isValidNpmExecPath(npmExecPath)).toBe(true)
    expect(isValidNpmExecPath('')).toBe(false)
    expect(isValidNpmExecPath('   ')).toBe(false)
    expect(isValidNpmExecPath(undefined)).toBe(false)
  })

  test('resolvePnpmLaunch fails closed on win32 when npm_execpath is absent/invalid', () => {
    const canonical: readonly string[] = ['bench:logical-payload']
    const execPath = '/usr/local/bin/node'
    const invalidValues: Array<string | undefined> = [undefined, '', '   ', '\t\n']
    for (const bad of invalidValues) {
      const result = resolvePnpmLaunch('win32', execPath, bad, canonical)
      expect('error' in result).toBe(true)
      if ('error' in result) {
        expect(result.error).toMatch(/npm_execpath/)
        expect(result.error).toMatch(/missing or invalid/)
      }
    }
    // valid still passes
    const good = resolvePnpmLaunch('win32', execPath, '/opt/pnpm/pnpm.cjs', canonical)
    expect('error' in good).toBe(false)
  })

  test('runPhase4Calibration uses Node+entry on win32 and pnpm elsewhere, keeps args and stdio inherit, no shell', () => {
    const fakeExec = '/fake/node'
    const fakeEntry = '/fake/pnpm/pnpm.cjs'
    const cases: Array<{ platform: string; expectWin: boolean }> = [
      { platform: 'win32', expectWin: true },
      { platform: 'darwin', expectWin: false },
      { platform: 'linux', expectWin: false }
    ]
    for (const { platform, expectWin } of cases) {
      const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv; options: unknown }> = []
      const deps: CalibrationDeps = {
        spawnSyncFn: (command, args, options) => {
          calls.push({ command, args, env: options.env, options })
          return { status: 0, signal: null }
        },
        env: { PATH: '/usr/bin', C02_HEAP_CALIBRATION: 'leak-should-be-stripped' } as NodeJS.ProcessEnv,
        stdout: () => {},
        stderr: () => {},
        platform,
        execPath: fakeExec,
        npmExecPath: fakeEntry
      }
      const result = runPhase4Calibration(undefined, deps)
      expect(result.exitCode).toBe(0)
      expect(calls).toHaveLength(4)
      for (let i = 0; i < calls.length; i++) {
        const canonicalArgs = PHASE4_CALIBRATION_STEPS[i].args
        if (expectWin) {
          expect(calls[i].command).toBe(fakeExec)
          expect(calls[i].args).toEqual([fakeEntry, ...canonicalArgs])
        } else {
          expect(calls[i].command).toBe('pnpm')
          expect(calls[i].args).toEqual(canonicalArgs)
        }
        // stdio inherit, no shell, argv-safe array (never a shell string)
        const opts = calls[i].options as { stdio: unknown; env: unknown; shell?: unknown }
        expect(opts.stdio).toBe('inherit')
        expect(opts.shell).toBeUndefined()
        expect(Array.isArray(calls[i].args)).toBe(true)
        // ensure no shell string construction: command and args are separate, not joined with shell metachars
        expect(calls[i].command).not.toMatch(/&&|\|\||;|\$\(/)
      }
      // env isolation still holds under both launchers
      expect(calls[0].env.C02_HEAP_CALIBRATION).toBeUndefined()
      expect(calls[1].env.C02_HEAP_CALIBRATION).toBeUndefined()
      expect(calls[2].env.C02_HEAP_CALIBRATION).toBeUndefined()
      expect(calls[3].env.C02_HEAP_CALIBRATION).toBe('mixed')
    }
  })

  test('runPhase4Calibration fails closed before spawn when Windows pnpm JS entry is absent/invalid', () => {
    const invalidEntries: Array<string | undefined> = [undefined, '', '   ']
    for (const badEntry of invalidEntries) {
      let spawned = false
      const stderrMessages: string[] = []
      const deps: CalibrationDeps = {
        spawnSyncFn: () => {
          spawned = true
          return { status: 0, signal: null }
        },
        env: { PATH: '/usr/bin' } as NodeJS.ProcessEnv,
        stdout: () => {},
        stderr: (msg) => stderrMessages.push(msg),
        platform: 'win32',
        execPath: '/fake/node',
        npmExecPath: badEntry
      }
      const result = runPhase4Calibration(undefined, deps)
      expect(result.exitCode).toBe(1)
      expect(result.failedStepId).toBe('c01-logical-payload')
      expect(spawned).toBe(false)
      const combined = stderrMessages.join('')
      expect(combined).toMatch(/npm_execpath/)
      expect(combined).toMatch(/missing or invalid/)
      expect(combined).toMatch(/aborted before spawn/)
    }

    // also ensure later-step failure path still fail-closed without partial spawn
    // empty entry should fail on first step regardless of later env, so no calls at all
    const stderr2: string[] = []
    let callCount = 0
    const deps2: CalibrationDeps = {
      spawnSyncFn: () => {
        callCount++
        return { status: 0, signal: null }
      },
      env: { PATH: '/usr/bin' } as NodeJS.ProcessEnv,
      stdout: () => {},
      stderr: (m) => stderr2.push(m),
      platform: 'win32',
      execPath: '/fake/node',
      npmExecPath: ''
    }
    const r2 = runPhase4Calibration(undefined, deps2)
    expect(r2.exitCode).toBe(1)
    expect(callCount).toBe(0)
    expect(stderr2.join('')).toMatch(/npm_execpath/)
  })

  test('canonical steps still declare pnpm (not pnpm.cmd) — launcher is runtime-only', () => {
    const steps = getPhase4CalibrationSteps()
    for (const s of steps) {
      expect(s.command).toBe('pnpm')
      expect(s.command).not.toBe('pnpm.cmd')
    }
    expect(validateCanonicalCommands(steps)).toEqual([])
  })
})
