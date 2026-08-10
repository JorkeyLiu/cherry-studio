/**
 * Lane preparation state machine (Phase 3a of the Native ABI Runtime Lane
 * refactor — preparation only; child execution and finalization are later
 * phases).
 *
 * A *lane* is a command run that guarantees the better-sqlite3 binding is in a
 * specific ABI state while it executes. Preparation turns a requested lane into
 * one of five discriminated outcomes:
 *
 *  - `nested`           — a valid same-checkout same-lane inherited lease
 *                         (LOCK-004): we are already inside the outer lane's
 *                         acquisition; nothing is acquired, ensured, or
 *                         rebuilt.
 *  - `lane-conflict`    — a valid same-checkout lease for the OPPOSITE lane
 *                         (LOCK-007): an explicit conflict. The lane is never
 *                         silently switched under another owner's lease.
 *  - `preparation-failure` — the checkout root could not be resolved, the outer
 *                         lock could not be acquired, or an injected seam
 *                         rejected; no lane work ran. A rejected acquisition
 *                         carries the lock path (and any owner the rejection
 *                         exposed) so the lock never becomes unreleasable.
 *  - `target-lane-failure` — the lock was acquired but the requested lane
 *                         could not be ensured (check/rebuild/verify failed or
 *                         the ensure seam rejected). The lock stays held and
 *                         the result carries the owner/token/lockPath/leaseEnv
 *                         plus the rejection diagnostic a finalizer needs.
 *  - `outer-prepared`   — the lock was acquired and the requested lane is
 *                         ensured. The result carries the acquired owner, the
 *                         ownership token, the lock path, the ensure report,
 *                         and the child lease env, ready for the runner to
 *                         execute the child and the finalizer to
 *                         restore/release.
 *
 * Contracts honored:
 *  - The lane is explicit (LOCK-001) — never inferred from paths, tests, or
 *    imports.
 *  - A missing, malformed, version-mismatched, or checkout-mismatched lease is
 *    never trusted (LOCK-005) and falls back to outer acquisition.
 *  - Native checks stay read-only (LOCK-002): rebuilds happen only through the
 *    injected ensure service, which is the single rebuild path.
 *
 * Deliberately out of scope in this phase: spawning the child, registering
 * parent signals, restoring the Electron ABI (LOCK-003), and releasing the
 * lock — those belong to the runner/finalizer phase. Every lock acquired here
 * is left held; the consumer of the result must release it with the returned
 * token.
 *
 * All external effects flow through injected seams (`RootResolver`,
 * `LeaseInspector`, `LockService`, `LaneEnsureService`) so the state machine
 * is deterministically unit-testable with fakes; `createPreparationSeams()`
 * wires the real modules.
 */

import path from 'node:path'

import { createEffects } from './effects'
import { createLaneAdapter, ensureLane, type LaneAdapter, type LaneEnsureResult } from './lanes'
import { type LaneLease, LEASE_ENV_NAME, leaseEnv, type LeaseParseResult, parseLease } from './lease'
import {
  acquireLock,
  defaultLockPath,
  type LaneId,
  type LockAcquireResult,
  type LockFs,
  type LockOwner,
  parseLockOwner
} from './lock'

/** Checkout root reported when root resolution failed (never a real path). */
export const UNRESOLVED_CHECKOUT = '(unresolved)'

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

/**
 * Canonical checkout-root resolution. The returned root must be an absolute
 * canonical path: it is compared verbatim against the lease owner's checkout
 * root (which `lock.ts` already records via `path.resolve`) and is passed to
 * the lock service unchanged. `undefined` means unresolvable and is a
 * preparation failure.
 */
export interface RootResolver {
  resolveCheckoutRoot(explicit: string | undefined): string | undefined
}

/** Default resolver: explicit wins, otherwise the project root. */
export function createDefaultResolver(projectRoot: string): RootResolver {
  return {
    resolveCheckoutRoot: (explicit) => (explicit !== undefined ? path.resolve(explicit) : path.resolve(projectRoot))
  }
}

/**
 * Lease concerns: reading the raw inherited lease, parsing it (pure), and
 * building the env a child inherits from a held lock owner. The default
 * implementation delegates to the pure `lease.ts` contracts.
 */
export interface LeaseInspector {
  /** The raw lease env var of the inherited environment (undefined when absent). */
  readRaw(env: NodeJS.ProcessEnv): string | undefined
  /** Parse a raw lease payload (same contract as `parseLease`). */
  parse(raw: string): LeaseParseResult
  /** Build the child env from a held lock owner (same contract as `leaseEnv`). */
  createLeaseEnv(env: NodeJS.ProcessEnv, owner: LockOwner): NodeJS.ProcessEnv
}

/** Real lease wiring: delegates to `lease.ts`. */
export function createLeaseInspector(): LeaseInspector {
  return {
    readRaw: (env) => env[LEASE_ENV_NAME],
    parse: (raw) => parseLease(raw),
    createLeaseEnv: (env, owner) => leaseEnv(env, owner)
  }
}

/** Options for the outer lock acquisition. */
export interface LockAcquireOptions {
  checkoutRoot: string
  lane: LaneId
  /** Owning PID; defaults to the current process PID in the real lock. */
  pid?: number
  /** Explicit acquisition token (deterministic tests). */
  token?: string
}

/**
 * The lock seam. Only `acquire` is needed by preparation; releasing the
 * acquired lock belongs to the finalizer phase, which consumes the ownership
 * metadata returned here.
 */
export interface LockService {
  acquire(opts: LockAcquireOptions): Promise<LockAcquireResult>
}

/** Real lock wiring: delegates to the existing `acquireLock`. */
export function createLockService(lockFs?: LockFs): LockService {
  return {
    acquire: (opts) =>
      acquireLock({
        checkoutRoot: opts.checkoutRoot,
        lane: opts.lane,
        pid: opts.pid,
        token: opts.token,
        fs: lockFs
      })
  }
}

/**
 * The single rebuild path (LOCK-002): check the target lane read-only, and
 * rebuild only when that check failed. The real service delegates to
 * `lanes.ensureLane`; tests inject scripted results.
 */
export interface LaneEnsureService {
  ensure(lane: LaneId): Promise<LaneEnsureResult>
}

/** Real ensure wiring: delegates to the existing `ensureLane` policy. */
export function createLaneEnsureService(adapter: LaneAdapter): LaneEnsureService {
  return { ensure: (lane) => ensureLane(adapter, lane) }
}

/** All preparation seams, wired together for the future runner/CLI. */
export interface PreparationSeams {
  resolver: RootResolver
  lease: LeaseInspector
  lock: LockService
  ensure: LaneEnsureService
}

/** Real wiring: every seam defaults to the existing native-abi modules. */
export function createPreparationSeams(overrides: Partial<PreparationSeams> = {}): PreparationSeams {
  const effects = createEffects()
  return {
    resolver: overrides.resolver ?? createDefaultResolver(effects.projectRoot()),
    lease: overrides.lease ?? createLeaseInspector(),
    lock: overrides.lock ?? createLockService(),
    ensure: overrides.ensure ?? createLaneEnsureService(createLaneAdapter(effects))
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Why preparation failed before any lane work (or before the ensure step). */
export type PreparationFailureReason =
  | { kind: 'root-resolution'; detail: string }
  | { kind: 'lock-acquire'; acquire: LockAcquireResult }
  | {
      kind: 'lock-acquire-rejected'
      /** Error diagnostic from the rejected acquire. */
      error: string
      /** Lock file path the finalizer may inspect/release (derived unless the rejection exposed one). */
      lockPath: string
      /**
       * Ownership metadata only when the rejected acquire exposed a valid owner
       * (LOCK-005: never a fabricated claim). Absent means indeterminate — the
       * finalizer must read the lock file itself before releasing.
       */
      owner?: LockOwner
    }

/** Valid same-checkout same-lane inherited lease (LOCK-004): no lock/ensure. */
export interface NestedPrepareResult {
  status: 'nested'
  lane: LaneId
  checkoutRoot: string
  /** The inherited lease that proved we are inside the outer lane. */
  lease: LaneLease
}

/** Lock acquired and the requested lane ensured; ready for the runner. */
export interface OuterPreparedResult {
  status: 'outer-prepared'
  lane: LaneId
  checkoutRoot: string
  acquire: LockAcquireResult & { acquired: true }
  owner: LockOwner
  /** Ownership proof the finalizer must pass to `releaseLock`. */
  token: string
  /** The lock file path the finalizer releases. */
  lockPath: string
  ensure: LaneEnsureResult
  /** The env a child would inherit: the caller's env plus the lane lease. */
  leaseEnv: NodeJS.ProcessEnv
}

/** Valid same-checkout opposite-lane lease (LOCK-007): explicit conflict. */
export interface LaneConflictPrepareResult {
  status: 'lane-conflict'
  lane: LaneId
  checkoutRoot: string
  /** The valid opposite-lane lease that caused the conflict. */
  lease: LaneLease
}

/** Root unresolvable or lock unacquirable; nothing ran. */
export interface PreparationFailureResult {
  status: 'preparation-failure'
  lane: LaneId
  checkoutRoot: string
  reason: PreparationFailureReason
}

/**
 * Outcome of the ensure seam on `target-lane-failure`: either a normal
 * `LaneEnsureResult`, or `'rejected'` when the ensure service threw (no result
 * exists; only the error diagnostic is carried).
 */
export type LaneEnsureOutcome = LaneEnsureResult | { status: 'rejected'; error: string }

/**
 * Lock acquired but the requested lane could not be ensured (including when the
 * ensure seam rejected). The lock is left held (release is the finalizer's
 * job); the result carries the ownership metadata plus the child lease env
 * (diagnostic — no child ran).
 */
export interface TargetLaneFailureResult {
  status: 'target-lane-failure'
  lane: LaneId
  checkoutRoot: string
  acquire: LockAcquireResult & { acquired: true }
  owner: LockOwner
  token: string
  lockPath: string
  ensure: LaneEnsureOutcome
  /** The lease env a child would have inherited (diagnostic; no child ran). */
  leaseEnv: NodeJS.ProcessEnv
}

/** Discriminated result of the lane preparation state machine. */
export type LanePrepareResult =
  | NestedPrepareResult
  | OuterPreparedResult
  | LaneConflictPrepareResult
  | PreparationFailureResult
  | TargetLaneFailureResult

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/** Human-readable diagnostic from an unknown seam rejection. */
function rejectionMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Release metadata a rejected lock acquisition may have left behind. A seam can
 * create the lock file and then reject, so the derived lock path is always
 * carried; an `owner` is claimed only when the rejection itself exposed a valid
 * one (LOCK-005 — never a fabricated ownership claim).
 */
function acquireRejectionMetadata(
  err: unknown,
  checkoutRoot: string
): { lockPath: string; owner: LockOwner | undefined } {
  const derived = defaultLockPath(checkoutRoot)
  if (typeof err !== 'object' || err === null) {
    return { lockPath: derived, owner: undefined }
  }
  const e = err as Record<string, unknown>
  const lockPath = typeof e.lockPath === 'string' && e.lockPath.length > 0 ? e.lockPath : derived
  return { lockPath, owner: parseLockOwner(e.owner) }
}

/** Inherited-lease classification driving the nested/conflict/outer decision. */
type InheritedLease = { kind: 'nested'; lease: LaneLease } | { kind: 'conflict'; lease: LaneLease } | { kind: 'none' }

/**
 * Classify the inherited lease (LOCK-004/005/007). `'none'` covers absent,
 * malformed, unsupported-version, and checkout-mismatched leases — none are
 * trusted, so the caller falls back to outer acquisition.
 */
function classifyLease(
  inspector: LeaseInspector,
  env: NodeJS.ProcessEnv,
  checkoutRoot: string,
  lane: LaneId
): InheritedLease {
  const raw = inspector.readRaw(env)
  if (raw === undefined) {
    // LOCK-005: an absent lease is not trusted.
    return { kind: 'none' }
  }
  const parsed = inspector.parse(raw)
  if (!parsed.ok) {
    // LOCK-005: malformed / unsupported-version leases are never trusted.
    return { kind: 'none' }
  }
  const { lease } = parsed
  if (lease.owner.checkoutRoot !== checkoutRoot) {
    // LOCK-005: a lease from a different checkout cannot cover this lane.
    return { kind: 'none' }
  }
  if (lease.owner.lane === lane) {
    // LOCK-004: a valid same-checkout same-lane lease means we are nested.
    return { kind: 'nested', lease }
  }
  // LOCK-007: a valid same-checkout opposite-lane lease is an explicit
  // conflict — never silently switch lanes under another owner's lease.
  return { kind: 'conflict', lease }
}

/** Options for `runLanePreparation`. */
export interface LanePreparationOptions {
  /** Explicit lane; never inferred (LOCK-001). */
  lane: LaneId
  /** Explicit checkout root; when absent, `resolver.resolveCheckoutRoot()` resolves it. */
  checkoutRoot?: string
  /** Environment to inspect for an inherited lease and to seed the child env from. */
  env?: NodeJS.ProcessEnv
  /** Owning PID for the outer lock; defaults to `process.pid` in the real lock. */
  pid?: number
  resolver: RootResolver
  lease: LeaseInspector
  lock: LockService
  ensure: LaneEnsureService
}

/**
 * Run the lane preparation state machine:
 *
 *  1. Resolve the canonical checkout root (preparation failure when
 *     unresolvable).
 *  2. Classify the inherited lease: nested (LOCK-004), lane conflict
 *     (LOCK-007), or untrusted -> outer (LOCK-005).
 *  3. Outer path: acquire the checkout-scoped lock, build the child lease env
 *     from the held owner, and ensure the requested lane through the injected
 *     service (the only rebuild path, LOCK-002).
 *
 * The acquired lock is left held on `outer-prepared` and `target-lane-failure`;
 * the consumer releases it with the returned token in a later phase.
 */
export async function runLanePreparation(options: LanePreparationOptions): Promise<LanePrepareResult> {
  const lane = options.lane
  const runEnv = options.env ?? process.env

  let resolved: string | undefined
  try {
    resolved = options.resolver.resolveCheckoutRoot(options.checkoutRoot)
  } catch (err) {
    // A rejecting resolver is still a preparation failure; no lock exists yet.
    return {
      status: 'preparation-failure',
      lane,
      checkoutRoot: UNRESOLVED_CHECKOUT,
      reason: { kind: 'root-resolution', detail: `checkout root resolution rejected: ${rejectionMessage(err)}` }
    }
  }
  if (resolved === undefined) {
    return {
      status: 'preparation-failure',
      lane,
      checkoutRoot: UNRESOLVED_CHECKOUT,
      reason: { kind: 'root-resolution', detail: 'checkout root could not be resolved' }
    }
  }
  const checkoutRoot = path.resolve(resolved)

  const inherited = classifyLease(options.lease, runEnv, checkoutRoot, lane)
  if (inherited.kind === 'nested') {
    // LOCK-004: already inside the outer lane's acquisition — nothing to do.
    return { status: 'nested', lane, checkoutRoot, lease: inherited.lease }
  }
  if (inherited.kind === 'conflict') {
    // LOCK-007: explicit conflict; never silently switch lanes.
    return { status: 'lane-conflict', lane, checkoutRoot, lease: inherited.lease }
  }

  // LOCK-005: absent/invalid/mismatched lease falls back to outer acquisition.
  let acquire: LockAcquireResult
  try {
    acquire = await options.lock.acquire({ checkoutRoot, lane, pid: options.pid })
  } catch (err) {
    // The acquire rejected; the lock file may already exist (a seam can create
    // it and then reject). Carry the lock path and any owner the rejection
    // exposed so the lock never becomes unreleasable; never claim ownership the
    // rejection did not prove.
    const meta = acquireRejectionMetadata(err, checkoutRoot)
    return {
      status: 'preparation-failure',
      lane,
      checkoutRoot,
      reason: {
        kind: 'lock-acquire-rejected',
        error: rejectionMessage(err),
        lockPath: meta.lockPath,
        ...(meta.owner !== undefined ? { owner: meta.owner } : {})
      }
    }
  }
  if (!acquire.acquired) {
    return {
      status: 'preparation-failure',
      lane,
      checkoutRoot,
      reason: { kind: 'lock-acquire', acquire }
    }
  }

  const owner = acquire.owner
  const token = owner.token
  const lockPath = acquire.lockPath
  const childLeaseEnv = options.lease.createLeaseEnv(runEnv, owner)

  let ensure: LaneEnsureResult
  try {
    ensure = await options.ensure.ensure(lane)
  } catch (err) {
    // The lock is held and stays held; carry the acquire/owner/token/lockPath/
    // leaseEnv metadata plus the rejection diagnostic so the finalizer can
    // release the lock.
    return {
      status: 'target-lane-failure',
      lane,
      checkoutRoot,
      acquire,
      owner,
      token,
      lockPath,
      ensure: { status: 'rejected', error: rejectionMessage(err) },
      leaseEnv: childLeaseEnv
    }
  }
  if (ensure.status !== 'ok') {
    // The lock stays held (releasing is the finalizer's job); carry the
    // ownership metadata the finalizer needs to release it.
    return {
      status: 'target-lane-failure',
      lane,
      checkoutRoot,
      acquire,
      owner,
      token,
      lockPath,
      ensure,
      leaseEnv: childLeaseEnv
    }
  }
  return {
    status: 'outer-prepared',
    lane,
    checkoutRoot,
    acquire,
    owner,
    token,
    lockPath,
    ensure,
    leaseEnv: childLeaseEnv
  }
}
