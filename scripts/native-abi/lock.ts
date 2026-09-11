/**
 * Checkout-scoped native ABI lane lock (Phase 1 of the Native ABI Runtime Lane
 * refactor).
 *
 * The repository has a single better-sqlite3 binding whose ABI is either Node
 * (137) or Electron (145) at any moment. A *lane* is a command run that
 * guarantees the binding is in a specific ABI state while it executes. This
 * module provides the atomic, checkout-scoped lock a lane holds for the
 * duration of that guarantee, plus the stale-owner reclaim and bounded-wait
 * policy a later runner phase consumes.
 *
 * Concurrency contract (LOCK-001): the lock is a runtime contract — the owner
 * is whoever atomically created the lock file first. ABI state is NEVER
 * inferred from directories, tests, imports, or module graphs; the lock only
 * serializes lane entry so the runner can then switch/verify state explicitly.
 *
 * All filesystem and process I/O goes through the injected `LockFs` seam so
 * the acquisition/reclaim/release policy is deterministically testable with
 * fakes; `createLockFs()` wires the real filesystem + `process.kill(pid, 0)`
 * liveness probe (cross-platform — never macOS-only `ps` assumptions). The
 * seam's `readFile` is discriminated: ENOENT/absence is distinct from any
 * other read failure, so a non-ENOENT-unreadable lock fails closed as an
 * observable error and is never reclaimed, and liveness EINVAL (indeterminate)
 * is never treated as stale.
 *
 * Atomic publish: a lock file is never written in place. The publisher writes
 * the complete payload to a unique sibling temp path (`wx` create-only) and
 * then atomically creates the lock path as a hard link to it
 * (`linkTemp`: `linkSync`, EEXIST = contention). Readers therefore observe
 * only absence or complete bytes — never an empty/partial file — so no
 * time-based grace is needed or used. The public lock path stays a regular
 * file; no overwrite-rename is ever used. Each publisher best-effort removes
 * only its own temp link; a crashed publisher may leave an inert sibling
 * temp file behind (never read as a lock, never scanned or reclaimed here).
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** The ABI lanes this repository manages (see `constants.ts`). */
export type LaneId = 'node' | 'electron'

/** Owner metadata recorded in the lock file and in the inherited lease. */
export interface LockOwner {
  /** PID of the process holding the lane. */
  pid: number
  /** Per-acquisition uniqueness token (ownership proof for release/reclaim). */
  token: string
  /** The ABI lane the owner holds ('node' or 'electron'). */
  lane: LaneId
  /** Canonical checkout root the lock is scoped to. */
  checkoutRoot: string
  /** Acquisition time (ms since epoch, from the injected clock). */
  timestamp: number
}

/** Lock file payload. */
export interface LockFile {
  version: 1
  owner: LockOwner
}

/** Lock file name at the checkout root (gitignorable dotfile). */
export const LOCK_FILE_NAME = '.native-abi-lock'

/** Lock file schema version. */
export const LOCK_FILE_VERSION = 1

/** Default bounded wait for a live owner before giving up. */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000

/** Default poll interval while waiting for a live owner. */
export const DEFAULT_POLL_INTERVAL_MS = 100

/** Derive the checkout-scoped lock file path (absolute). */
export function defaultLockPath(checkoutRoot: string): string {
  return path.join(path.resolve(checkoutRoot), LOCK_FILE_NAME)
}

/**
 * Bounded temp-name collision retries inside one atomic publish. Temp names
 * are unique per acquisition (pid + token), so a collision only means a
 * leftover temp from a crashed owner with a recycled name; exceeding the bound
 * is an observable error, never an infinite loop.
 */
export const MAX_PUBLISH_TEMP_ATTEMPTS = 10

/**
 * Sibling temp path for the atomic publish of `lockPath`. Same directory as
 * the lock (hard links require it), unique per acquisition attempt, and never
 * equal to the lock path itself.
 */
export function tempPublishPath(lockPath: string, owner: LockOwner, attempt: number): string {
  const safeToken = owner.token.replace(/[^A-Za-z0-9_-]/g, '_')
  return `${lockPath}.tmp.${owner.pid}.${safeToken}.${attempt}`
}

/** Serialize a lock file for atomic creation. */
export function serializeLockFile(lock: LockFile): string {
  return `${JSON.stringify(lock, null, 2)}\n`
}

/**
 * Parse an owner object, validating every field. Returns undefined when the
 * payload is not a well-formed owner (fail-closed: a malformed owner is never
 * treated as a live holder).
 */
export function parseLockOwner(raw: unknown): LockOwner | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }
  const o = raw as Record<string, unknown>
  if (typeof o.pid !== 'number' || !Number.isInteger(o.pid) || o.pid <= 0) {
    return undefined
  }
  if (typeof o.token !== 'string' || o.token.length === 0) {
    return undefined
  }
  if (o.lane !== 'node' && o.lane !== 'electron') {
    return undefined
  }
  if (typeof o.checkoutRoot !== 'string' || o.checkoutRoot.length === 0 || !path.isAbsolute(o.checkoutRoot)) {
    return undefined
  }
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) {
    return undefined
  }
  return { pid: o.pid, token: o.token, lane: o.lane, checkoutRoot: o.checkoutRoot, timestamp: o.timestamp }
}

/**
 * Parse a lock file payload. Undefined means absent OR unparseable — both are
 * treated as no valid owner. Absence is decided at the `LockFs` seam (the
 * `readFile` 'absent' result); non-ENOENT read errors never reach this
 * function because `acquireLock`/`releaseLock` fail closed on them first. The
 * caller re-reads under the token guard before removal, so a lock changed
 * between reads is never deleted.
 */
export function parseLockFile(content: string | undefined): LockFile | undefined {
  if (content === undefined) {
    return undefined
  }
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }
  const r = raw as Record<string, unknown>
  if (r.version !== LOCK_FILE_VERSION) {
    return undefined
  }
  const owner = parseLockOwner(r.owner)
  if (owner === undefined) {
    return undefined
  }
  return { version: LOCK_FILE_VERSION, owner }
}

/**
 * Cross-platform PID liveness probe (`process.kill(pid, 0)` semantics):
 * `true` when a process with that PID exists, `false` otherwise. EPERM means
 * the process exists but belongs to another user (alive); ESRCH means no such
 * process (dead). Any other failure (EINVAL and unexpected errors) cannot
 * prove death — fail closed and treat the PID as alive/unknown, so a lock is
 * never reclaimed on an indeterminate liveness probe.
 */
export function isPidAliveDefault(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Discriminated lock file read result. Absence (ENOENT) is distinct from any
 * other read failure: a non-ENOENT-unreadable lock must fail closed (never be
 * reclaimed or deleted) rather than being mistaken for an absent file.
 */
export type LockReadResult =
  | { status: 'ok'; content: string }
  | { status: 'absent' }
  | { status: 'error'; error: string }

/**
 * The I/O seam for the lock. `lock.ts` policy consumes only this interface;
 * `createLockFs()` is the real wiring and tests inject deterministic fakes.
 */
export interface LockFs {
  /**
   * Create-only write of a sibling temp file (the first half of the atomic
   * publish). Returns 'written' when the temp file was fully written,
   * 'exists' when that temp path already exists (caller retries with the next
   * attempt suffix), or an error message string on any other failure.
   * Required: there is no non-atomic fallback — every lock file reaches the
   * lock path only through `linkTemp` below.
   */
  writeTemp(tempPath: string, content: string): 'written' | 'exists' | string
  /**
   * Atomically create the lock path as a hard link to an already-written temp
   * file (the second half of the atomic publish; never an overwriting
   * rename). Returns 'linked' when this caller won, 'exists' when the lock
   * path already exists (contention — the caller lost), or an error message
   * string on any other failure (e.g. EPERM, ENOENT, EXDEV). The temp link is
   * always cleaned up best-effort by the caller afterwards. Required: the
   * pair is the only publish path, so readers never observe a partial file.
   */
  linkTemp(tempPath: string, lockPath: string): 'linked' | 'exists' | string
  /**
   * Read a text file with discriminated results: 'ok' with the content,
   * 'absent' for a missing file (ENOENT), or 'error' for any other read
   * failure (e.g. EACCES). Non-ENOENT read failures are never treated as
   * absence.
   */
  readFile(p: string): LockReadResult
  /** Remove a file; undefined on success (ENOENT counts as success), error message on failure. */
  removeFile(p: string): string | undefined
  /** Cross-platform PID liveness probe. */
  isPidAlive(pid: number): boolean
  /** Async wait used by the bounded poll loop (injected so tests never sleep). */
  sleep(ms: number): Promise<void>
  /** Clock used for owner timestamps and wait deadlines. */
  now(): number
  /** Per-acquisition uniqueness token generator. */
  randomToken(): string
}

function errnoCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err) {
    return (err as NodeJS.ErrnoException).code
  }
  return undefined
}

/** Real I/O wiring: filesystem + `process.kill(pid, 0)` + real time. */
export function createLockFs(): LockFs {
  return {
    writeTemp: (tempPath, content) => {
      try {
        fs.writeFileSync(tempPath, content, { flag: 'wx' })
        return 'written'
      } catch (err) {
        if (errnoCode(err) === 'EEXIST') {
          return 'exists'
        }
        return `writeFileSync(${tempPath}): ${err instanceof Error ? err.message : String(err)}`
      }
    },
    linkTemp: (tempPath, lockPath) => {
      try {
        fs.linkSync(tempPath, lockPath)
        return 'linked'
      } catch (err) {
        if (errnoCode(err) === 'EEXIST') {
          return 'exists'
        }
        return `linkSync(${tempPath} -> ${lockPath}): ${err instanceof Error ? err.message : String(err)}`
      }
    },
    readFile: (p) => {
      try {
        return { status: 'ok', content: fs.readFileSync(p, 'utf8') }
      } catch (err) {
        if (errnoCode(err) === 'ENOENT') {
          return { status: 'absent' }
        }
        return {
          status: 'error',
          error: `readFileSync(${p}): ${err instanceof Error ? err.message : String(err)}`
        }
      }
    },
    removeFile: (p) => {
      try {
        fs.unlinkSync(p)
        return undefined
      } catch (err) {
        if (errnoCode(err) === 'ENOENT') {
          return undefined
        }
        return `unlinkSync(${p}): ${err instanceof Error ? err.message : String(err)}`
      }
    },
    isPidAlive: isPidAliveDefault,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    randomToken: () => randomUUID()
  }
}

/** Options for `acquireLock`. */
export interface AcquireLockOptions {
  /** Canonical checkout root the lock is scoped to (also recorded in the owner). */
  checkoutRoot: string
  /** The ABI lane being entered. */
  lane: LaneId
  /** Owning PID; defaults to the current process PID. */
  pid?: number
  /** Explicit acquisition token (deterministic tests); defaults to `fs.randomToken()`. */
  token?: string
  /** Bounded total wait for a live owner (ms); `0` = single attempt, no waiting. Must be a finite nonnegative number, else `'error'`. */
  timeoutMs?: number
  /** Poll interval while waiting for a live owner (ms). Must be a finite positive number, else `'error'`. */
  pollIntervalMs?: number
  /** Lock file path override (tests); defaults to `defaultLockPath(checkoutRoot)`. */
  lockPath?: string
  /** Injected I/O seam; defaults to `createLockFs()`. */
  fs?: LockFs
}

export type LockAcquireResult =
  | { acquired: true; owner: LockOwner; lockPath: string }
  | { acquired: false; reason: 'locked' | 'timeout'; owner: LockOwner; lockPath: string }
  | { acquired: false; reason: 'error'; error: string; lockPath: string }

/**
 * `true` only when two parsed lock files both carry a valid owner with the
 * same acquisition token. An unparseable read (undefined) never proves
 * identity and never matches through this guard; malformed orphans follow
 * their own explicit double-read reclaim branch in `acquireLock`.
 */
function sameLockIdentity(a: LockFile | undefined, b: LockFile | undefined): boolean {
  if (a === undefined || b === undefined) {
    return false
  }
  return a.owner.token === b.owner.token
}

/**
 * Atomically publish `content` at `lockPath`: write the complete payload to a
 * unique sibling temp path, then hard-link it as the lock path. Returns
 * 'created' when this caller won, 'exists' on contention, or an error message
 * string. The caller's own temp link is removed best-effort on every path
 * after the write (cleanup failures are ignored); a temp name collision
 * retries with the next attempt suffix. There is deliberately no non-atomic
 * fallback: the pair is required on `LockFs`, so a seam without it does not
 * compile and production can never silently downgrade to a partial-visible
 * write.
 */
function publishExclusiveLock(
  fs_: LockFs,
  lockPath: string,
  content: string,
  owner: LockOwner
): 'created' | 'exists' | string {
  for (let attempt = 0; attempt < MAX_PUBLISH_TEMP_ATTEMPTS; attempt++) {
    const tempPath = tempPublishPath(lockPath, owner, attempt)
    const written = fs_.writeTemp(tempPath, content)
    if (written === 'exists') {
      continue
    }
    if (written !== 'written') {
      fs_.removeFile(tempPath)
      return written
    }
    const linked = fs_.linkTemp(tempPath, lockPath)
    fs_.removeFile(tempPath)
    if (linked === 'linked') {
      return 'created'
    }
    if (linked === 'exists') {
      return 'exists'
    }
    return linked
  }
  return `publish temp collision: too many temp files for ${lockPath}`
}

/**
 * Acquire the checkout-scoped lane lock.
 *
 * Atomic publish (sibling temp write + `linkSync` hard-link create): the
 * first publisher wins — once the publish returns `'created'`, that owner
 * holds the lane and no other contender may delete the new file. Readers
 * observe only absence or complete bytes, so there is no partial-write window
 * and no time-based grace anywhere in this policy; `timeoutMs === 0` is a
 * single attempt that never sleeps. On contention the current owner is read
 * and classified:
 *  - live owner (valid lock, PID alive): poll until the bounded deadline, then
 *    report `'locked'` (immediate, `timeoutMs === 0`) or `'timeout'` (waited);
 *  - dead owner (valid lock, PID dead): reclaim — re-read the file and only
 *    remove it when it still shows the same valid owner identity (strict token
 *    guard; a malformed/absent guard never matches), then retry the publish. A
 *    lock re-acquired between the reads is never removed; the next iteration
 *    re-evaluates the fresh owner.
 *  - present-but-unparseable: safe to reclaim after one guard re-read ONLY
 *    because every current writer publishes atomically (sibling temp write +
 *    hard-link create), so no in-repo writer can ever present a partial file
 *    to a reader. A malformed payload is therefore an old-version, external,
 *    or legacy orphan — never a live writer mid-write. Re-read once so a
 *    valid lock published between the reads is never deleted (a fresh live
 *    owner honors the deadline; a fresh dead owner is re-evaluated next
 *    pass); a still-malformed guard is reclaimed immediately with no waiting.
 *  - absent after `exists` (removed between the calls): retry the publish
 *    immediately without deleting anything.
 *
 * Every non-contention I/O failure is returned as an observable `'error'`
 * result (lock-target cleanup/removal failures are never silently swallowed;
 * own-temp cleanup is best-effort and ignored).
 */
export async function acquireLock(opts: AcquireLockOptions): Promise<LockAcquireResult> {
  const fs_ = opts.fs ?? createLockFs()
  const checkoutRoot = path.resolve(opts.checkoutRoot)
  const lockPath = opts.lockPath ?? defaultLockPath(checkoutRoot)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  // Invalid wait budgets are observable errors, never silent misbehavior: a
  // non-finite/negative timeout cannot bound a wait, and a non-positive poll
  // interval cannot poll. `0` stays valid for both as "single attempt".
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return {
      acquired: false,
      reason: 'error',
      error: `timeoutMs must be a finite nonnegative number; got ${String(timeoutMs)}`,
      lockPath
    }
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    return {
      acquired: false,
      reason: 'error',
      error: `pollIntervalMs must be a finite positive number; got ${String(pollIntervalMs)}`,
      lockPath
    }
  }
  const owner: LockOwner = {
    pid: opts.pid ?? process.pid,
    token: opts.token ?? fs_.randomToken(),
    lane: opts.lane,
    checkoutRoot,
    timestamp: fs_.now()
  }
  const deadline = fs_.now() + timeoutMs
  const lockFile = serializeLockFile({ version: LOCK_FILE_VERSION, owner })

  for (;;) {
    const published = publishExclusiveLock(fs_, lockPath, lockFile, owner)
    if (published === 'created') {
      return { acquired: true, owner, lockPath }
    }
    if (published !== 'exists') {
      return { acquired: false, reason: 'error', error: published, lockPath }
    }

    const currentRead = fs_.readFile(lockPath)
    if (currentRead.status === 'error') {
      // Fail closed: a lock that cannot be read (non-ENOENT) must never be
      // reclaimed or deleted — report it as an observable error.
      return { acquired: false, reason: 'error', error: `reading lock file: ${currentRead.error}`, lockPath }
    }
    if (currentRead.status === 'absent') {
      // The file vanished between `exists` and the read (a rival reclaimed it
      // or the winner was removed): nothing to delete, retry the publish.
      continue
    }
    const existing = parseLockFile(currentRead.content)
    if (existing !== undefined) {
      if (fs_.isPidAlive(existing.owner.pid)) {
        // A live owner holds the lock: wait only while the budget allows.
        if (fs_.now() >= deadline) {
          return {
            acquired: false,
            reason: timeoutMs === 0 ? 'locked' : 'timeout',
            owner: existing.owner,
            lockPath
          }
        }
        await fs_.sleep(pollIntervalMs)
        continue
      }

      // Dead valid owner: reclaim only under the strict token guard. The guard
      // must still show the same valid owner; a malformed/absent/changed guard
      // never matches and is re-evaluated (never deleted) on the next pass.
      const guardRead = fs_.readFile(lockPath)
      if (guardRead.status === 'error') {
        // Fail closed on the guard re-read too: never remove a lock whose
        // current content we could not prove stale.
        return {
          acquired: false,
          reason: 'error',
          error: `reading lock file (reclaim guard): ${guardRead.error}`,
          lockPath
        }
      }
      if (guardRead.status === 'absent') {
        continue
      }
      const before = parseLockFile(guardRead.content)
      if (!sameLockIdentity(before, existing)) {
        // Owner changed between the reads: never delete the fresh content. A
        // fresh live owner honors the bounded deadline immediately
        // (preserving the zero-budget 'locked' report without sleeping); any
        // other fresh state is re-evaluated on the next pass.
        if (before !== undefined && fs_.isPidAlive(before.owner.pid) && fs_.now() >= deadline) {
          return {
            acquired: false,
            reason: timeoutMs === 0 ? 'locked' : 'timeout',
            owner: before.owner,
            lockPath
          }
        }
        continue
      }
      const removalError = fs_.removeFile(lockPath)
      if (removalError !== undefined) {
        return { acquired: false, reason: 'error', error: `stale lock removal failed: ${removalError}`, lockPath }
      }
      // Loop to retry the publish; a concurrent acquirer may have won the
      // reclaim race, in which case the next iteration re-evaluates the fresh
      // owner.
      continue
    }

    // Present-but-unparseable: every current writer publishes atomically, so
    // this cannot be a live writer mid-write — only an old-version, external,
    // or legacy orphan (there is no in-repo legacy partial writer left: the
    // non-atomic path was removed, not deprecated). Re-read once so a valid
    // lock published between the reads is never deleted; no waiting, so
    // `timeoutMs: 0` never sleeps here.
    const malformedGuard = fs_.readFile(lockPath)
    if (malformedGuard.status === 'error') {
      return {
        acquired: false,
        reason: 'error',
        error: `reading lock file (malformed guard): ${malformedGuard.error}`,
        lockPath
      }
    }
    if (malformedGuard.status === 'absent') {
      continue
    }
    const guardParsed = parseLockFile(malformedGuard.content)
    if (guardParsed !== undefined) {
      if (fs_.isPidAlive(guardParsed.owner.pid)) {
        if (fs_.now() >= deadline) {
          return {
            acquired: false,
            reason: timeoutMs === 0 ? 'locked' : 'timeout',
            owner: guardParsed.owner,
            lockPath
          }
        }
        await fs_.sleep(pollIntervalMs)
        continue
      }
      // Fresh dead valid owner: re-evaluate through the token-guard path.
      continue
    }
    // Still malformed on both reads: a genuine orphan under atomic publish.
    // Reclaim immediately with no waiting.
    const orphanRemoval = fs_.removeFile(lockPath)
    if (orphanRemoval !== undefined) {
      return { acquired: false, reason: 'error', error: `stale lock removal failed: ${orphanRemoval}`, lockPath }
    }
  }
}

/** Options for `releaseLock`. */
export interface ReleaseLockOptions {
  /** Checkout root the released lock is scoped to. */
  checkoutRoot: string
  /** Lock file path override (tests); defaults to `defaultLockPath(checkoutRoot)`. */
  lockPath?: string
  /** Ownership proof: the token of the acquisition being released. */
  token: string
  /** Injected I/O seam; defaults to `createLockFs()`. */
  fs?: LockFs
}

export type LockReleaseResult =
  | { released: true; lockPath: string }
  | { released: false; reason: 'absent' | 'not-owner' | 'error'; error?: string; lockPath: string }

/**
 * Release the checkout-scoped lane lock, ownership-guarded by `token`. The
 * lock is removed only when it still carries the same acquisition token at the
 * moment of removal — the content is re-read immediately before the unlink, so
 * a lock released and re-acquired between the reads is never deleted. A
 * foreign or unprovable lock is reported `'not-owner'`, an already-absent lock
 * is `'absent'` (idempotent cleanup), and any read/removal failure is an
 * observable `'error'` (never treated as absence).
 */
export function releaseLock(opts: ReleaseLockOptions): LockReleaseResult {
  const fs_ = opts.fs ?? createLockFs()
  const lockPath = opts.lockPath ?? defaultLockPath(opts.checkoutRoot)
  const first = fs_.readFile(lockPath)
  if (first.status === 'error') {
    return { released: false, reason: 'error', error: `reading lock file: ${first.error}`, lockPath }
  }
  if (first.status === 'absent') {
    return { released: false, reason: 'absent', lockPath }
  }
  const parsed = parseLockFile(first.content)
  if (parsed === undefined || parsed.owner.token !== opts.token) {
    // Never delete a lock we cannot prove we own (missing/foreign token).
    return { released: false, reason: 'not-owner', lockPath }
  }
  // Final token guard: re-read immediately before the unlink. The lock may
  // have been released and re-acquired (or become unreadable) since the first
  // read; only a lock that still carries our acquisition token is removed.
  const last = fs_.readFile(lockPath)
  if (last.status === 'error') {
    return { released: false, reason: 'error', error: `reading lock file (release guard): ${last.error}`, lockPath }
  }
  if (last.status === 'absent') {
    return { released: false, reason: 'absent', lockPath }
  }
  const lastParsed = parseLockFile(last.content)
  if (lastParsed === undefined || lastParsed.owner.token !== opts.token) {
    return { released: false, reason: 'not-owner', lockPath }
  }
  const removalError = fs_.removeFile(lockPath)
  if (removalError !== undefined) {
    return { released: false, reason: 'error', error: removalError, lockPath }
  }
  return { released: true, lockPath }
}
