import { describe, expect, it } from 'vitest'

import type { LaneAdapter, LaneEnsureResult } from '../lanes'
import { LEASE_ENV_NAME, leaseFromEnv, withLease } from '../lease'
import { defaultLockPath, type LaneId, type LockAcquireResult, type LockOwner } from '../lock'
import {
  createDefaultResolver,
  createLaneEnsureService,
  createLeaseInspector,
  createPreparationSeams,
  type LaneEnsureService,
  type LanePreparationOptions,
  type LockService,
  type RootResolver,
  runLanePreparation
} from '../prepare'
import type { CheckReport, RebuildReport } from '../types'

// ---------------------------------------------------------------------------
// Deterministic fakes: a scripted lock service, a scripted ensure service,
// and a scripted resolver. Lease read/parse/env creation uses the REAL pure
// lease.ts contracts via `createLeaseInspector()` unless overridden. No child
// process, signal, restore, or release seam exists in this module by design.
// ---------------------------------------------------------------------------

const CHECKOUT = '/repo/checkout'

function owner(overrides: Partial<LockOwner> = {}): LockOwner {
  return {
    pid: 4242,
    token: 'tok-outer',
    lane: 'node',
    checkoutRoot: CHECKOUT,
    timestamp: 1,
    ...overrides
  }
}

function inheritedEnv(owner_ = owner()): NodeJS.ProcessEnv {
  return withLease({ PATH: '/usr/bin' }, { version: 1, owner: owner_ })
}

function acquired(checkoutRoot = CHECKOUT, ownerOverrides: Partial<LockOwner> = {}): LockAcquireResult {
  return {
    acquired: true,
    owner: owner({ checkoutRoot, ...ownerOverrides }),
    lockPath: defaultLockPath(checkoutRoot)
  }
}

function lockFailure(
  reason: 'locked' | 'timeout' | 'error',
  detail: { error?: string; checkoutRoot?: string } = {}
): LockAcquireResult {
  const root = detail.checkoutRoot ?? CHECKOUT
  if (reason === 'error') {
    return {
      acquired: false,
      reason: 'error',
      error: detail.error ?? 'writeFileSync: EACCES',
      lockPath: defaultLockPath(root)
    }
  }
  return { acquired: false, reason, owner: owner({ checkoutRoot: root }), lockPath: defaultLockPath(root) }
}

function checkReport(lane: LaneId, ok: boolean, failures: string[] = []): CheckReport {
  return {
    target: lane,
    ok,
    runtimeName: lane === 'node' ? 'node' : 'electron',
    runtimeVersion: lane === 'node' ? '24.11.1' : '41.2.1',
    abi: lane === 'node' ? 137 : 145,
    platform: 'darwin',
    arch: 'arm64',
    markerState: 'ignored',
    sqlVerified: ok,
    failures
  }
}

function rebuildReport(lane: LaneId, ok: boolean, failures: string[] = []): RebuildReport {
  return {
    target: lane,
    ok,
    nodeVersion: '24.11.1',
    abi: 137,
    platform: 'darwin',
    arch: 'arm64',
    markerBefore: [],
    toolOutput: [],
    failures
  }
}

function ensureOk(lane: LaneId, rebuilt = false): LaneEnsureResult {
  const good = checkReport(lane, true)
  if (rebuilt) {
    return {
      status: 'ok',
      lane,
      rebuilt: true,
      check: checkReport(lane, false, ['node ABI 137 missing']),
      rebuild: rebuildReport(lane, true),
      verify: good
    }
  }
  return { status: 'ok', lane, rebuilt: false, check: good, verify: good }
}

function ensureRebuildFailed(lane: LaneId): LaneEnsureResult {
  return {
    status: 'rebuild-failed',
    lane,
    check: checkReport(lane, false, ['check: node ABI 137 missing']),
    rebuild: rebuildReport(lane, false, ['node-gyp exited with code 1', 'EACCES: permission denied'])
  }
}

function ensureVerifyFailed(lane: LaneId): LaneEnsureResult {
  return {
    status: 'verify-failed',
    lane,
    check: checkReport(lane, false, ['initial electron check failed']),
    rebuild: rebuildReport(lane, true),
    verify: checkReport(lane, false, ['post-rebuild electron check failed'])
  }
}

class FakeLockService implements LockService {
  acquireResults: LockAcquireResult[] = []
  acquireErrors: unknown[] = []
  acquireCalls: Array<{ checkoutRoot: string; lane: LaneId; pid?: number; token?: string }> = []

  async acquire(opts: {
    checkoutRoot: string
    lane: LaneId
    pid?: number
    token?: string
  }): Promise<LockAcquireResult> {
    this.acquireCalls.push(opts)
    const nextErr = this.acquireErrors.shift()
    if (nextErr !== undefined) {
      throw nextErr
    }
    const next = this.acquireResults.shift()
    if (next === undefined) {
      throw new Error('FakeLockService: no scripted acquire result')
    }
    return next
  }
}

class FakeEnsureService implements LaneEnsureService {
  ensureResults: LaneEnsureResult[] = []
  ensureErrors: unknown[] = []
  ensureCalls: LaneId[] = []

  async ensure(lane: LaneId): Promise<LaneEnsureResult> {
    this.ensureCalls.push(lane)
    const nextErr = this.ensureErrors.shift()
    if (nextErr !== undefined) {
      throw nextErr
    }
    const next = this.ensureResults.shift()
    if (next === undefined) {
      throw new Error('FakeEnsureService: no scripted ensure result')
    }
    return next
  }
}

class FakeResolver implements RootResolver {
  checkoutRoot: string | undefined = CHECKOUT
  resolveCalls: Array<string | undefined> = []

  resolveCheckoutRoot(explicit: string | undefined): string | undefined {
    this.resolveCalls.push(explicit)
    return explicit ?? this.checkoutRoot
  }
}

class Harness {
  lock = new FakeLockService()
  ensure = new FakeEnsureService()
  resolver = new FakeResolver()
  lease = createLeaseInspector()

  options(overrides: Partial<LanePreparationOptions> = {}): LanePreparationOptions {
    return {
      lane: 'node',
      resolver: this.resolver,
      lease: this.lease,
      lock: this.lock,
      ensure: this.ensure,
      ...overrides
    }
  }
}

// ---------------------------------------------------------------------------

describe('nested lease (LOCK-004)', () => {
  it('a valid same-checkout same-lane lease is nested: no lock, no ensure', async () => {
    const h = new Harness()
    const env = inheritedEnv(owner({ token: 'tok-nested', lane: 'node' }))

    const result = await runLanePreparation(h.options({ env }))

    expect(result.status).toBe('nested')
    if (result.status === 'nested') {
      expect(result.lane).toBe('node')
      expect(result.checkoutRoot).toBe(CHECKOUT)
      expect(result.lease.owner.token).toBe('tok-nested')
    }
    // No outer acquisition, no rebuild path.
    expect(h.lock.acquireCalls).toEqual([])
    expect(h.ensure.ensureCalls).toEqual([])
  })

  it('is nested for an electron lane under an electron lease', async () => {
    const h = new Harness()
    const env = inheritedEnv(owner({ token: 'tok-e', lane: 'electron' }))

    const result = await runLanePreparation(h.options({ lane: 'electron', env }))

    expect(result.status).toBe('nested')
    expect(h.lock.acquireCalls).toEqual([])
    expect(h.ensure.ensureCalls).toEqual([])
  })
})

describe('opposite-lane lease (LOCK-007)', () => {
  it('a valid same-checkout opposite-lane lease is an explicit conflict', async () => {
    const h = new Harness()
    const env = inheritedEnv(owner({ token: 'tok-electron', lane: 'electron' }))

    const result = await runLanePreparation(h.options({ lane: 'node', env }))

    expect(result.status).toBe('lane-conflict')
    if (result.status === 'lane-conflict') {
      expect(result.checkoutRoot).toBe(CHECKOUT)
      expect(result.lease.owner.lane).toBe('electron')
      expect(result.lease.owner.token).toBe('tok-electron')
    }
    // Never silently switches lane: no lock, no ensure.
    expect(h.lock.acquireCalls).toEqual([])
    expect(h.ensure.ensureCalls).toEqual([])
  })

  it('conflicts in the reverse direction (node lease, electron lane)', async () => {
    const h = new Harness()
    const env = inheritedEnv(owner({ lane: 'node' }))

    const result = await runLanePreparation(h.options({ lane: 'electron', env }))

    expect(result.status).toBe('lane-conflict')
    if (result.status === 'lane-conflict') {
      expect(result.lease.owner.lane).toBe('node')
    }
    expect(h.lock.acquireCalls).toEqual([])
  })
})

describe('untrusted lease falls back to outer acquisition (LOCK-005)', () => {
  function scriptOuter(h: Harness): void {
    h.lock.acquireResults.push(acquired())
    h.ensure.ensureResults.push(ensureOk('node'))
  }

  it('absent lease -> outer acquisition', async () => {
    const h = new Harness()
    scriptOuter(h)

    const result = await runLanePreparation(h.options({ env: { PATH: '/usr/bin' } }))

    expect(result.status).toBe('outer-prepared')
    expect(h.lock.acquireCalls).toHaveLength(1)
    expect(h.ensure.ensureCalls).toEqual(['node'])
  })

  it('malformed lease payload -> outer acquisition (not trusted)', async () => {
    const h = new Harness()
    scriptOuter(h)

    const result = await runLanePreparation(h.options({ env: { [LEASE_ENV_NAME]: 'not-json{' } }))

    expect(result.status).toBe('outer-prepared')
    expect(h.lock.acquireCalls).toHaveLength(1)
    expect(h.ensure.ensureCalls).toEqual(['node'])
  })

  it('unsupported lease version -> outer acquisition (not trusted)', async () => {
    const h = new Harness()
    scriptOuter(h)

    // A future schema version is unsupported: build the raw payload directly
    // (serializeLease is typed for the current version: 1 contract only).
    const env = { [LEASE_ENV_NAME]: JSON.stringify({ version: 99, owner: owner() }) }
    const result = await runLanePreparation(h.options({ env }))

    expect(result.status).toBe('outer-prepared')
    expect(h.lock.acquireCalls).toHaveLength(1)
  })

  it('checkout-mismatched lease -> outer acquisition (not trusted)', async () => {
    const h = new Harness()
    scriptOuter(h)

    const env = inheritedEnv(owner({ checkoutRoot: '/other/checkout', token: 'tok-other' }))
    const result = await runLanePreparation(h.options({ env }))

    expect(result.status).toBe('outer-prepared')
    expect(h.lock.acquireCalls).toHaveLength(1)
  })
})

describe('preparation failure (root resolution / lock acquisition)', () => {
  it('an unresolvable checkout root fails before any lock or ensure', async () => {
    const h = new Harness()
    h.resolver.checkoutRoot = undefined

    const result = await runLanePreparation(h.options({}))

    expect(result.status).toBe('preparation-failure')
    if (result.status === 'preparation-failure') {
      expect(result.reason.kind).toBe('root-resolution')
      expect(result.checkoutRoot).toBe('(unresolved)')
    }
    expect(h.lock.acquireCalls).toEqual([])
    expect(h.ensure.ensureCalls).toEqual([])
  })

  it('a locked/timeout lock acquisition fails preparation; ensure never runs', async () => {
    const h = new Harness()
    h.lock.acquireResults.push(lockFailure('timeout'))

    const result = await runLanePreparation(h.options({}))

    expect(result.status).toBe('preparation-failure')
    if (
      result.status === 'preparation-failure' &&
      result.reason.kind === 'lock-acquire' &&
      !result.reason.acquire.acquired
    ) {
      expect(result.reason.acquire.reason).toBe('timeout')
      expect(result.reason.acquire.lockPath).toBe(defaultLockPath(CHECKOUT))
    }
    expect(h.ensure.ensureCalls).toEqual([])
  })

  it('a lock I/O error is reported as preparation failure with the error detail', async () => {
    const h = new Harness()
    h.lock.acquireResults.push(lockFailure('error', { error: 'reading lock file: EACCES' }))

    const result = await runLanePreparation(h.options({}))

    expect(result.status).toBe('preparation-failure')
    if (
      result.status === 'preparation-failure' &&
      result.reason.kind === 'lock-acquire' &&
      !result.reason.acquire.acquired &&
      result.reason.acquire.reason === 'error'
    ) {
      expect(result.reason.acquire.error).toBe('reading lock file: EACCES')
    }
    expect(h.ensure.ensureCalls).toEqual([])
  })
})

describe('outer acquisition + lane ensure', () => {
  it('acquires, ensures without rebuilding, and returns the prepared outer result', async () => {
    const h = new Harness()
    h.lock.acquireResults.push(acquired(CHECKOUT, { token: 'tok-acq' }))
    h.ensure.ensureResults.push(ensureOk('node', false))

    const result = await runLanePreparation(h.options({}))

    expect(result.status).toBe('outer-prepared')
    if (result.status === 'outer-prepared') {
      expect(result.acquire.acquired).toBe(true)
      expect(result.owner.token).toBe('tok-acq')
      expect(result.token).toBe('tok-acq')
      expect(result.lockPath).toBe(defaultLockPath(CHECKOUT))
      expect(result.ensure.status).toBe('ok')
      if (result.ensure.status === 'ok') {
        expect(result.ensure.rebuilt).toBe(false)
      }
    }
    expect(h.lock.acquireCalls).toEqual([{ checkoutRoot: CHECKOUT, lane: 'node', pid: undefined }])
    expect(h.ensure.ensureCalls).toEqual(['node'])
  })

  it('acquires and reports a performed rebuild when the ensure service rebuilt (LOCK-002)', async () => {
    const h = new Harness()
    h.lock.acquireResults.push(acquired())
    h.ensure.ensureResults.push(ensureOk('node', true))

    const result = await runLanePreparation(h.options({}))

    expect(result.status).toBe('outer-prepared')
    if (result.status === 'outer-prepared') {
      expect(result.ensure.status).toBe('ok')
      if (result.ensure.status === 'ok') {
        expect(result.ensure.rebuilt).toBe(true)
      }
    }
  })

  it('passes an explicit checkout root and pid to the lock service', async () => {
    const h = new Harness()
    h.lock.acquireResults.push(acquired('/explicit/root'))
    h.ensure.ensureResults.push(ensureOk('node'))

    const result = await runLanePreparation(h.options({ checkoutRoot: '/explicit/root', pid: 99 }))

    expect(result.status).toBe('outer-prepared')
    expect(h.lock.acquireCalls).toEqual([{ checkoutRoot: '/explicit/root', lane: 'node', pid: 99 }])
    // The explicit root flows through the resolver (explicit wins).
    expect(h.resolver.resolveCalls).toEqual(['/explicit/root'])
  })
})

describe('target lane ensure failure (lock held for the finalizer)', () => {
  it('rebuild-failed -> target-lane-failure with diagnostics and held-lock metadata', async () => {
    const h = new Harness()
    h.lock.acquireResults.push(acquired())
    h.ensure.ensureResults.push(ensureRebuildFailed('node'))

    const result = await runLanePreparation(h.options({}))

    expect(result.status).toBe('target-lane-failure')
    if (result.status === 'target-lane-failure') {
      expect(result.ensure.status).toBe('rebuild-failed')
      if (result.ensure.status === 'rebuild-failed') {
        expect(result.ensure.rebuild.failures).toEqual(['node-gyp exited with code 1', 'EACCES: permission denied'])
      }
      // The finalizer needs the ownership metadata to release the held lock.
      expect(result.acquire.acquired).toBe(true)
      expect(result.owner.token).toBe('tok-outer')
      expect(result.token).toBe('tok-outer')
      expect(result.lockPath).toBe(defaultLockPath(CHECKOUT))
    }
    expect(h.ensure.ensureCalls).toEqual(['node'])
  })

  it('verify-failed -> target-lane-failure with the post-rebuild check retained', async () => {
    const h = new Harness()
    h.lock.acquireResults.push(acquired())
    h.ensure.ensureResults.push(ensureVerifyFailed('node'))

    const result = await runLanePreparation(h.options({}))

    expect(result.status).toBe('target-lane-failure')
    if (result.status === 'target-lane-failure' && result.ensure.status === 'verify-failed') {
      expect(result.ensure.verify.failures).toEqual(['post-rebuild electron check failed'])
    }
  })
})

describe('injected seam rejections (structured results; locks stay releasable)', () => {
  it('a rejecting resolver is a preparation failure with the rejection diagnostic', async () => {
    const h = new Harness()

    const result = await runLanePreparation(
      h.options({
        resolver: {
          resolveCheckoutRoot: () => {
            throw new Error('resolver exploded')
          }
        }
      })
    )

    expect(result.status).toBe('preparation-failure')
    if (result.status === 'preparation-failure' && result.reason.kind === 'root-resolution') {
      expect(result.reason.detail).toContain('resolver exploded')
      expect(result.checkoutRoot).toBe('(unresolved)')
    }
    // No lock or ensure ever runs after a resolver rejection.
    expect(h.lock.acquireCalls).toEqual([])
    expect(h.ensure.ensureCalls).toEqual([])
  })

  it('a rejecting lock acquire is a preparation failure carrying the lock path and no ownership claim', async () => {
    const h = new Harness()
    h.lock.acquireErrors.push(new Error('lock exploded before create'))

    const result = await runLanePreparation(h.options({}))

    expect(result.status).toBe('preparation-failure')
    if (result.status === 'preparation-failure' && result.reason.kind === 'lock-acquire-rejected') {
      expect(result.reason.error).toContain('lock exploded before create')
      // The lock file may already exist; the finalizer can still inspect/release it.
      expect(result.reason.lockPath).toBe(defaultLockPath(CHECKOUT))
      // No ownership is claimed unless the rejection proved it.
      expect(result.reason.owner).toBeUndefined()
    }
    expect(h.ensure.ensureCalls).toEqual([])
  })

  it('preserves ownership metadata when the rejected acquire exposed a valid owner', async () => {
    const h = new Harness()
    h.lock.acquireErrors.push(
      Object.assign(new Error('lock exploded after create'), {
        owner: owner({ token: 'tok-orphan' })
      })
    )

    const result = await runLanePreparation(h.options({}))

    expect(result.status).toBe('preparation-failure')
    if (result.status === 'preparation-failure' && result.reason.kind === 'lock-acquire-rejected') {
      expect(result.reason.error).toContain('lock exploded after create')
      expect(result.reason.lockPath).toBe(defaultLockPath(CHECKOUT))
      // The exposed owner (and its token) is preserved for a token-guarded release.
      expect(result.reason.owner?.token).toBe('tok-orphan')
    }
    expect(h.ensure.ensureCalls).toEqual([])
  })

  it('a rejecting ensure after acquisition is a target-lane-failure with the held-lock metadata and the diagnostic', async () => {
    const h = new Harness()
    h.lock.acquireResults.push(acquired(CHECKOUT, { token: 'tok-acq' }))
    h.ensure.ensureErrors.push(new Error('ensure exploded'))

    const result = await runLanePreparation(h.options({ env: { PATH: '/usr/bin' } }))

    expect(result.status).toBe('target-lane-failure')
    if (result.status === 'target-lane-failure') {
      // Full held-lock metadata so a finalizer can release the lock.
      expect(result.acquire.acquired).toBe(true)
      expect(result.owner.token).toBe('tok-acq')
      expect(result.token).toBe('tok-acq')
      expect(result.lockPath).toBe(defaultLockPath(CHECKOUT))
      expect(result.ensure.status).toBe('rejected')
      if (result.ensure.status === 'rejected') {
        expect(result.ensure.error).toContain('ensure exploded')
      }
      // The child lease env is still carried (diagnostic; no child ran).
      expect(leaseFromEnv(result.leaseEnv)?.owner.token).toBe('tok-acq')
    }
    expect(h.lock.acquireCalls).toEqual([{ checkoutRoot: CHECKOUT, lane: 'node', pid: undefined }])
  })
})

describe('child lease env creation', () => {
  it('outer-prepared carries the acquired-owner lease and preserves the base env', async () => {
    const h = new Harness()
    const base = { PATH: '/usr/bin', FOO: 'bar' }
    h.lock.acquireResults.push(acquired(CHECKOUT, { token: 'tok-acq', lane: 'node' }))
    h.ensure.ensureResults.push(ensureOk('node'))

    const result = await runLanePreparation(h.options({ env: base }))

    expect(result.status).toBe('outer-prepared')
    if (result.status === 'outer-prepared') {
      const childLease = leaseFromEnv(result.leaseEnv)
      expect(childLease?.owner.token).toBe('tok-acq')
      expect(childLease?.owner.lane).toBe('node')
      expect(childLease?.owner.checkoutRoot).toBe(CHECKOUT)
      expect(result.leaseEnv.PATH).toBe('/usr/bin')
      expect(result.leaseEnv.FOO).toBe('bar')
      // The input environment is never mutated.
      expect(base[LEASE_ENV_NAME]).toBeUndefined()
    }
  })

  it('target-lane-failure carries the lease env (diagnostic) alongside the lock metadata', async () => {
    const h = new Harness()
    h.lock.acquireResults.push(acquired(CHECKOUT, { token: 'tok-acq' }))
    h.ensure.ensureResults.push(ensureRebuildFailed('node'))

    const result = await runLanePreparation(h.options({ env: { PATH: '/usr/bin' } }))

    expect(result.status).toBe('target-lane-failure')
    if (result.status === 'target-lane-failure') {
      expect(leaseFromEnv(result.leaseEnv)?.owner.token).toBe('tok-acq')
      expect(result.token).toBe('tok-acq')
      expect(result.lockPath).toBe(defaultLockPath(CHECKOUT))
    }
  })
})

describe('default seam wiring', () => {
  it('createLaneEnsureService delegates to lanes.ensureLane (check, then rebuild only on failure)', async () => {
    const adapter = new FakeAdapter()
    adapter.scriptCheck('node', checkReport('node', false, ['node ABI 137 missing']), checkReport('node', true))
    adapter.scriptRebuild('node', rebuildReport('node', true))

    const service = createLaneEnsureService(adapter)

    const result = await service.ensure('node')

    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.rebuilt).toBe(true)
    }
    expect(adapter.checkCalls).toEqual(['node', 'node'])
    expect(adapter.rebuildCalls).toEqual(['node'])
  })

  it('createPreparationSeams wires the real modules by default (no binding touched)', async () => {
    const seams = createPreparationSeams()
    // Resolver: the repo project root resolves to an absolute path.
    expect(seams.resolver.resolveCheckoutRoot(undefined)).toBeDefined()
    // Lease parse: the real pure parser is wired.
    expect(seams.lease.parse('not-json').ok).toBe(false)
    // Lock and ensure services exist; exercising them would touch real I/O,
    // so only their presence is asserted here.
    expect(seams.lock).toBeDefined()
    expect(seams.ensure).toBeDefined()
  })

  it('createDefaultResolver prefers an explicit root and canonicalizes both paths', () => {
    const resolver = createDefaultResolver('/repo/project')
    expect(resolver.resolveCheckoutRoot(undefined)).toBe('/repo/project')
    expect(resolver.resolveCheckoutRoot('/explicit/root')).toBe('/explicit/root')
  })
})

// ---------------------------------------------------------------------------
// Minimal scripted LaneAdapter proving the default ensure service follows the
// lanes.ensureLane policy (no real binding or subprocess involved).
// ---------------------------------------------------------------------------

class FakeAdapter implements LaneAdapter {
  checkQueue = new Map<LaneId, CheckReport[]>()
  rebuildQueue = new Map<LaneId, RebuildReport[]>()
  checkCalls: LaneId[] = []
  rebuildCalls: LaneId[] = []

  scriptCheck(lane: LaneId, ...reports: CheckReport[]): void {
    this.checkQueue.set(lane, [...reports])
  }

  scriptRebuild(lane: LaneId, ...reports: RebuildReport[]): void {
    this.rebuildQueue.set(lane, [...reports])
  }

  check(lane: LaneId): CheckReport {
    this.checkCalls.push(lane)
    const next = this.checkQueue.get(lane)?.shift()
    if (next === undefined) {
      throw new Error(`no scripted check for lane ${lane}`)
    }
    return next
  }

  async rebuild(lane: LaneId): Promise<RebuildReport> {
    this.rebuildCalls.push(lane)
    const next = this.rebuildQueue.get(lane)?.shift()
    if (next === undefined) {
      throw new Error(`no scripted rebuild for lane ${lane}`)
    }
    return next
  }
}
