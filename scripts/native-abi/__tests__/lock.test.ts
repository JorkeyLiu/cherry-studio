import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import {
  acquireLock,
  createLockFs,
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  defaultLockPath,
  isPidAliveDefault,
  LOCK_FILE_NAME,
  type LockFile,
  type LockFs,
  type LockOwner,
  type LockReadResult,
  parseLockFile,
  parseLockOwner,
  releaseLock,
  serializeLockFile
} from '../lock'

// ---------------------------------------------------------------------------
// Deterministic LockFs fake: in-memory file map, controllable liveness clock,
// scripted reads, scripted failures, and a zero-cost sleep that advances the
// clock so the bounded poll loop is fully deterministic (no real waiting).
// ---------------------------------------------------------------------------

class FakeLockFs implements LockFs {
  files = new Map<string, string>()
  alivePids = new Set<number>()
  /** Failures injected per path (consumed on first matching call). */
  createErrors = new Map<string, string>()
  removeErrors = new Map<string, string>()
  /**
   * Scripted readFile results, consumed in order. Strings and `undefined` are
   * shorthand for an 'ok' read and an 'absent' read respectively; callers can
   * inject explicit `LockReadResult` values (e.g. 'error') directly. When the
   * queue is empty the read falls back to `files`.
   */
  scriptedReads: (LockReadResult | string | undefined)[] = []
  sleepCalls: number[] = []
  removedPaths: string[] = []
  /** Kill the seeded owner PID after this many sleep calls (mid-wait exit). */
  dieAfterSleeps = Infinity
  tokenQueue: string[] = []
  clock = 1000

  now(): number {
    return this.clock
  }

  async sleep(ms: number): Promise<void> {
    this.sleepCalls.push(ms)
    this.clock += ms
    if (this.sleepCalls.length >= this.dieAfterSleeps) {
      for (const pid of this.alivePids) {
        this.alivePids.delete(pid)
      }
    }
  }

  randomToken(): string {
    return this.tokenQueue.shift() ?? `tok-${this.tokenQueue.length}-${Math.random().toString(36).slice(2)}`
  }

  isPidAlive(pid: number): boolean {
    return this.alivePids.has(pid)
  }

  createExclusive(p: string, content: string): 'created' | 'exists' | string {
    const error = this.createErrors.get(p)
    if (error !== undefined) {
      this.createErrors.delete(p)
      return error
    }
    if (this.files.has(p)) {
      return 'exists'
    }
    this.files.set(p, content)
    return 'created'
  }

  readFile(p: string): LockReadResult {
    if (this.scriptedReads.length > 0) {
      const next = this.scriptedReads.shift()
      if (next === undefined) {
        return { status: 'absent' }
      }
      if (typeof next === 'string') {
        return { status: 'ok', content: next }
      }
      return next
    }
    const content = this.files.get(p)
    return content === undefined ? { status: 'absent' } : { status: 'ok', content }
  }

  removeFile(p: string): string | undefined {
    const error = this.removeErrors.get(p)
    if (error !== undefined) {
      this.removeErrors.delete(p)
      return error
    }
    if (this.files.delete(p)) {
      this.removedPaths.push(p)
    }
    return undefined
  }
}

const CHECKOUT = path.resolve('/repo/checkout')
const LOCK = defaultLockPath(CHECKOUT)

function owner(overrides: Partial<LockOwner>): LockOwner {
  return {
    pid: 4242,
    token: 'tok-owner',
    lane: 'electron',
    checkoutRoot: CHECKOUT,
    timestamp: 1,
    ...overrides
  }
}

function lockFile(owner: LockOwner): LockFile {
  return { version: 1, owner }
}

/** Seed a stale lock file (dead PID) owned by `token`. */
function seedStale(fake: FakeLockFs, overrides: Partial<LockOwner> = {}): LockOwner {
  const stale = owner({ pid: 99999, token: 'tok-stale', ...overrides })
  fake.files.set(LOCK, serializeLockFile(lockFile(stale)))
  return stale
}

describe('acquireLock / releaseLock (checkout-scoped lane lock)', () => {
  it('acquires atomically and records full owner metadata', async () => {
    const fake = new FakeLockFs()
    const result = await acquireLock({
      checkoutRoot: CHECKOUT,
      lane: 'node',
      pid: 1234,
      token: 'tok-new',
      timeoutMs: 0,
      fs: fake
    })

    expect(result).toEqual({
      acquired: true,
      owner: { pid: 1234, token: 'tok-new', lane: 'node', checkoutRoot: CHECKOUT, timestamp: fake.clock },
      lockPath: LOCK
    })
    const stored = parseLockFile(fake.files.get(LOCK))
    expect(stored).toEqual({
      version: 1,
      owner: { pid: 1234, token: 'tok-new', lane: 'node', checkoutRoot: CHECKOUT, timestamp: fake.clock }
    })
    expect(fake.sleepCalls).toEqual([])
  })

  it('releases an owned lock and reports absent on a second release', async () => {
    const fake = new FakeLockFs()
    await acquireLock({ checkoutRoot: CHECKOUT, lane: 'node', pid: 1, token: 'tok-a', timeoutMs: 0, fs: fake })

    const first = releaseLock({ checkoutRoot: CHECKOUT, token: 'tok-a', fs: fake })
    expect(first).toEqual({ released: true, lockPath: LOCK })
    expect(fake.files.has(LOCK)).toBe(false)

    const second = releaseLock({ checkoutRoot: CHECKOUT, token: 'tok-a', fs: fake })
    expect(second).toEqual({ released: false, reason: 'absent', lockPath: LOCK })
  })

  it('refuses to release with a mismatched token and leaves the file intact', async () => {
    const fake = new FakeLockFs()
    const stored = seedStale(fake, { pid: 1 }) // live owner, token tok-stale
    fake.alivePids.add(stored.pid)
    const before = fake.files.get(LOCK)

    const result = releaseLock({ checkoutRoot: CHECKOUT, token: 'tok-wrong', fs: fake })
    expect(result).toEqual({ released: false, reason: 'not-owner', lockPath: LOCK })
    expect(fake.files.get(LOCK)).toBe(before)
    expect(fake.removedPaths).toEqual([])
  })

  it('refuses to release a malformed lock file (ownership not provable)', async () => {
    const fake = new FakeLockFs()
    fake.files.set(LOCK, 'not-json{')

    const result = releaseLock({ checkoutRoot: CHECKOUT, token: 'tok-anything', fs: fake })
    expect(result).toEqual({ released: false, reason: 'not-owner', lockPath: LOCK })
    expect(fake.files.get(LOCK)).toBe('not-json{')
  })

  it('surfaces a release removal failure as an observable error', async () => {
    const fake = new FakeLockFs()
    const stored = seedStale(fake, { pid: 1 })
    fake.alivePids.add(stored.pid)
    fake.removeErrors.set(LOCK, 'EACCES: permission denied')

    const result = releaseLock({ checkoutRoot: CHECKOUT, token: 'tok-stale', fs: fake })
    expect(result).toEqual({
      released: false,
      reason: 'error',
      error: 'EACCES: permission denied',
      lockPath: LOCK
    })
    expect(fake.files.has(LOCK)).toBe(true)
  })

  it('reports live-owner contention as locked without touching the file', async () => {
    const fake = new FakeLockFs()
    const live = seedStale(fake, { pid: 777 })
    fake.alivePids.add(live.pid)
    const before = fake.files.get(LOCK)

    const result = await acquireLock({
      checkoutRoot: CHECKOUT,
      lane: 'node',
      pid: 123,
      token: 'tok-new',
      timeoutMs: 0,
      fs: fake
    })

    expect(result).toEqual({ acquired: false, reason: 'locked', owner: live, lockPath: LOCK })
    expect(fake.files.get(LOCK)).toBe(before)
    expect(fake.removedPaths).toEqual([])
    expect(fake.sleepCalls).toEqual([])
  })

  it('reclaims a stale owner (dead PID) and acquires with a fresh token', async () => {
    const fake = new FakeLockFs()
    const stale = seedStale(fake) // pid 99999 not in alivePids

    const result = await acquireLock({
      checkoutRoot: CHECKOUT,
      lane: 'electron',
      pid: 555,
      token: 'tok-reclaim',
      timeoutMs: 0,
      fs: fake
    })

    expect(result.acquired).toBe(true)
    expect(fake.removedPaths).toEqual([LOCK])
    const stored = parseLockFile(fake.files.get(LOCK))
    expect(stored?.owner).toEqual({
      pid: 555,
      token: 'tok-reclaim',
      lane: 'electron',
      checkoutRoot: CHECKOUT,
      timestamp: fake.clock
    })
    expect(stored?.owner.token).not.toBe(stale.token)
  })

  it('reclaims a malformed lock file as a stale owner', async () => {
    const fake = new FakeLockFs()
    fake.files.set(LOCK, 'garbage-not-json')

    const result = await acquireLock({
      checkoutRoot: CHECKOUT,
      lane: 'node',
      pid: 9,
      token: 'tok-clean',
      timeoutMs: 0,
      fs: fake
    })

    expect(result.acquired).toBe(true)
    expect(parseLockFile(fake.files.get(LOCK))?.owner.token).toBe('tok-clean')
  })

  it('polls a live owner and times out after the bounded deadline', async () => {
    const fake = new FakeLockFs()
    const live = seedStale(fake, { pid: 777 })
    fake.alivePids.add(live.pid)

    const result = await acquireLock({
      checkoutRoot: CHECKOUT,
      lane: 'node',
      pid: 123,
      token: 'tok-new',
      timeoutMs: 150,
      pollIntervalMs: 50,
      fs: fake
    })

    expect(result).toEqual({ acquired: false, reason: 'timeout', owner: live, lockPath: LOCK })
    // 3 polls: clock 1000 -> 1150 deadline, sleeps at 1000/1050/1100.
    expect(fake.sleepCalls).toEqual([50, 50, 50])
    expect(fake.removedPaths).toEqual([])
    expect(parseLockFile(fake.files.get(LOCK))?.owner.token).toBe(live.token)
  })

  it('acquires mid-wait once the live owner exits (poll observes state change)', async () => {
    const fake = new FakeLockFs()
    const live = seedStale(fake, { pid: 777 })
    fake.alivePids.add(live.pid)
    fake.dieAfterSleeps = 2 // owner exits after the 2nd poll

    const result = await acquireLock({
      checkoutRoot: CHECKOUT,
      lane: 'node',
      pid: 321,
      token: 'tok-won',
      timeoutMs: 1000,
      pollIntervalMs: 50,
      fs: fake
    })

    expect(result.acquired).toBe(true)
    expect(fake.sleepCalls.length).toBe(2)
    expect(parseLockFile(fake.files.get(LOCK))?.owner.token).toBe('tok-won')
  })

  it('never removes a lock re-acquired between reads (token guard)', async () => {
    const fake = new FakeLockFs()
    const stale = seedStale(fake) // pid 99999 dead
    const fresh = owner({ pid: 888, token: 'tok-fresh', lane: 'node' })
    fake.alivePids.add(fresh.pid)
    // First read sees the stale owner; the guard re-read sees a fresh live owner.
    fake.scriptedReads = [serializeLockFile(lockFile(stale)), serializeLockFile(lockFile(fresh))]

    const result = await acquireLock({
      checkoutRoot: CHECKOUT,
      lane: 'node',
      pid: 123,
      token: 'tok-new',
      timeoutMs: 0,
      fs: fake
    })

    // The file changed between reads -> the guard refuses removal; with a zero
    // wait budget the fresh live owner (seen in the guard re-read) is reported
    // as contention, and the on-disk stale lock is untouched.
    expect(result).toEqual({ acquired: false, reason: 'locked', owner: fresh, lockPath: LOCK })
    expect(fake.removedPaths).toEqual([])
    expect(fake.files.get(LOCK)).toBe(serializeLockFile(lockFile(stale)))
  })

  it('surfaces a stale reclaim removal failure as an observable error', async () => {
    const fake = new FakeLockFs()
    const stale = seedStale(fake)
    fake.removeErrors.set(LOCK, 'EPERM: operation not permitted')

    const result = await acquireLock({
      checkoutRoot: CHECKOUT,
      lane: 'node',
      pid: 123,
      token: 'tok-new',
      timeoutMs: 0,
      fs: fake
    })

    expect(result).toEqual({
      acquired: false,
      reason: 'error',
      error: 'stale lock removal failed: EPERM: operation not permitted',
      lockPath: LOCK
    })
    expect(parseLockFile(fake.files.get(LOCK))?.owner.token).toBe(stale.token)
  })

  it('surfaces a non-contention create failure as an observable error', async () => {
    const fake = new FakeLockFs()
    fake.createErrors.set(LOCK, 'ENOSPC: no space left on device')

    const result = await acquireLock({
      checkoutRoot: CHECKOUT,
      lane: 'node',
      pid: 123,
      token: 'tok-new',
      timeoutMs: 0,
      fs: fake
    })

    expect(result).toEqual({
      acquired: false,
      reason: 'error',
      error: 'ENOSPC: no space left on device',
      lockPath: LOCK
    })
  })

  it('fails closed on a non-ENOENT read error instead of reclaiming (file untouched)', async () => {
    const fake = new FakeLockFs()
    seedStale(fake) // dead owner pid 99999 would otherwise be reclaimable
    fake.scriptedReads = [{ status: 'error', error: 'EACCES: permission denied' }]
    const before = fake.files.get(LOCK)

    const result = await acquireLock({
      checkoutRoot: CHECKOUT,
      lane: 'node',
      pid: 123,
      token: 'tok-new',
      timeoutMs: 0,
      fs: fake
    })

    expect(result).toEqual({
      acquired: false,
      reason: 'error',
      error: expect.stringContaining('EACCES: permission denied'),
      lockPath: LOCK
    })
    expect(fake.files.get(LOCK)).toBe(before)
    expect(fake.removedPaths).toEqual([])
  })

  it('fails closed when the reclaim-guard re-read errors (never removes an unreadable lock)', async () => {
    const fake = new FakeLockFs()
    const stale = seedStale(fake) // dead owner: first read succeeds
    // First read sees the stale owner; the token-guard re-read fails.
    fake.scriptedReads = [serializeLockFile(lockFile(stale)), { status: 'error', error: 'EIO: input/output error' }]

    const result = await acquireLock({
      checkoutRoot: CHECKOUT,
      lane: 'node',
      pid: 123,
      token: 'tok-new',
      timeoutMs: 0,
      fs: fake
    })

    expect(result).toEqual({
      acquired: false,
      reason: 'error',
      error: expect.stringContaining('EIO: input/output error'),
      lockPath: LOCK
    })
    expect(fake.removedPaths).toEqual([])
    expect(fake.files.get(LOCK)).toBe(serializeLockFile(lockFile(stale)))
  })

  it('release fails closed on a non-ENOENT read error (file untouched)', async () => {
    const fake = new FakeLockFs()
    const mine = seedStale(fake, { pid: 1, token: 'tok-mine' })
    fake.alivePids.add(mine.pid)
    fake.scriptedReads = [{ status: 'error', error: 'EACCES: permission denied' }]
    const before = fake.files.get(LOCK)

    const result = releaseLock({ checkoutRoot: CHECKOUT, token: 'tok-mine', fs: fake })
    expect(result).toEqual({
      released: false,
      reason: 'error',
      error: expect.stringContaining('EACCES: permission denied'),
      lockPath: LOCK
    })
    expect(fake.files.get(LOCK)).toBe(before)
    expect(fake.removedPaths).toEqual([])
  })

  it('release detects a lock replaced between the first read and the unlink (final token guard)', async () => {
    const fake = new FakeLockFs()
    const mine = owner({ pid: 1, token: 'tok-mine' })
    const replacement = owner({ pid: 2, token: 'tok-replacement', lane: 'node' })
    fake.files.set(LOCK, serializeLockFile(lockFile(mine)))
    // First read sees our lock; the final guard re-read sees a fresh owner.
    fake.scriptedReads = [serializeLockFile(lockFile(mine)), serializeLockFile(lockFile(replacement))]
    const before = fake.files.get(LOCK)

    const result = releaseLock({ checkoutRoot: CHECKOUT, token: 'tok-mine', fs: fake })
    expect(result).toEqual({ released: false, reason: 'not-owner', lockPath: LOCK })
    expect(fake.removedPaths).toEqual([])
    expect(fake.files.get(LOCK)).toBe(before)
  })

  it('release reports absent when the lock vanishes before the unlink', async () => {
    const fake = new FakeLockFs()
    const mine = owner({ pid: 1, token: 'tok-mine' })
    fake.files.set(LOCK, serializeLockFile(lockFile(mine)))
    // First read sees our lock; the final guard re-read finds no file.
    fake.scriptedReads = [serializeLockFile(lockFile(mine)), undefined]

    const result = releaseLock({ checkoutRoot: CHECKOUT, token: 'tok-mine', fs: fake })
    expect(result).toEqual({ released: false, reason: 'absent', lockPath: LOCK })
    expect(fake.removedPaths).toEqual([])
  })

  it('rejects a non-finite or negative timeoutMs as an observable error', async () => {
    const fake = new FakeLockFs()
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = await acquireLock({
        checkoutRoot: CHECKOUT,
        lane: 'node',
        pid: 1,
        token: 'tok-budget',
        timeoutMs: bad,
        fs: fake
      })
      expect(result.acquired).toBe(false)
      if (!result.acquired) {
        expect(result.reason).toBe('error')
      }
    }
    // Nothing was created or removed: the budget is rejected before any I/O.
    expect(fake.files.size).toBe(0)
    expect(fake.removedPaths).toEqual([])
  })

  it('rejects a non-finite or non-positive pollIntervalMs as an observable error', async () => {
    const fake = new FakeLockFs()
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await acquireLock({
        checkoutRoot: CHECKOUT,
        lane: 'node',
        pid: 1,
        token: 'tok-budget',
        pollIntervalMs: bad,
        fs: fake
      })
      expect(result.acquired).toBe(false)
      if (!result.acquired) {
        expect(result.reason).toBe('error')
      }
    }
    expect(fake.files.size).toBe(0)
    expect(fake.removedPaths).toEqual([])
  })

  it('fails closed on a parsed owner with a relative checkoutRoot', () => {
    const raw = serializeLockFile({ version: 1, owner: owner({ checkoutRoot: 'relative/checkout' }) })
    expect(parseLockOwner(JSON.parse(raw).owner)).toBeUndefined()
    expect(parseLockFile(raw)).toBeUndefined()
  })

  it('default liveness probe treats EINVAL as alive/unknown (never stale)', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('invalid argument') as NodeJS.ErrnoException
      err.code = 'EINVAL'
      throw err
    })
    try {
      expect(isPidAliveDefault(12345)).toBe(true)
      expect(isPidAliveDefault(1)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('honors the default polling constants and lock file name', () => {
    expect(DEFAULT_ACQUIRE_TIMEOUT_MS).toBe(10_000)
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(100)
    expect(LOCK_FILE_NAME).toBe('.native-abi-lock')
    expect(defaultLockPath('/x/y')).toBe(path.join(path.resolve('/x/y'), '.native-abi-lock'))
  })

  it('default liveness probe treats only a real process as alive', () => {
    expect(isPidAliveDefault(process.pid)).toBe(true)
    expect(isPidAliveDefault(999_999_999)).toBe(false)
    expect(isPidAliveDefault(0)).toBe(false)
    expect(isPidAliveDefault(-1)).toBe(false)
    expect(isPidAliveDefault(Number.NaN)).toBe(false)
  })
})

describe('checkout-scoped lock packaging contract', () => {
  it('is ignored by the root .gitignore so the lock can never dirty a clean packaging build', () => {
    // The test file lives at <root>/scripts/native-abi/__tests__/lock.test.ts.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
    const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')
    expect(gitignore.split(/\r?\n/)).toContain(LOCK_FILE_NAME)
  })
})

describe('acquireLock / releaseLock with the real LockFs seam', () => {
  it('acquires and releases through the real filesystem in a temp checkout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-abi-lock-'))
    try {
      const real = createLockFs()
      const lockPath = defaultLockPath(dir)

      const acquired = await acquireLock({
        checkoutRoot: dir,
        lane: 'electron',
        token: 'tok-real',
        timeoutMs: 0,
        fs: real
      })
      expect(acquired.acquired).toBe(true)
      expect(fs.existsSync(lockPath)).toBe(true)
      expect(parseLockFile(fs.readFileSync(lockPath, 'utf8'))?.owner.token).toBe('tok-real')

      // A second acquisition against our own live PID is contention, never a
      // reclaim (real process.kill liveness).
      const contended = await acquireLock({
        checkoutRoot: dir,
        lane: 'node',
        token: 'tok-other',
        timeoutMs: 0,
        fs: real
      })
      expect(contended.acquired).toBe(false)
      if (!contended.acquired) {
        expect(contended.reason).toBe('locked')
      }
      expect(parseLockFile(fs.readFileSync(lockPath, 'utf8'))?.owner.token).toBe('tok-real')

      const released = releaseLock({ checkoutRoot: dir, token: 'tok-real', fs: real })
      expect(released).toEqual({ released: true, lockPath })
      expect(fs.existsSync(lockPath)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reclaims a dead owner through the real filesystem wiring (real subprocess)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-abi-lock-dead-'))
    try {
      const real = createLockFs()
      const lockPath = defaultLockPath(dir)
      const childToken = `tok-child-${Date.now()}`
      const child = await runChild([dir, lockPath, childToken])
      expect(child.code).toBe(0)
      expect(JSON.parse(child.stdout).acquired).toBe(true)
      expect(fs.existsSync(lockPath)).toBe(true)

      const held = parseLockFile(fs.readFileSync(lockPath, 'utf8'))
      expect(held?.owner.token).toBe(childToken)
      // The owner is the exited, reaped child: provably dead via real process.kill.
      expect(isPidAliveDefault(held!.owner.pid)).toBe(false)

      const acquired = await acquireLock({
        checkoutRoot: dir,
        lane: 'node',
        token: 'tok-parent',
        timeoutMs: 0,
        fs: real
      })
      expect(acquired.acquired).toBe(true)
      const now = parseLockFile(fs.readFileSync(lockPath, 'utf8'))
      expect(now?.owner.token).toBe('tok-parent')
      expect(now?.owner.pid).toBe(process.pid)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('resolves atomic lock contention with exactly one winner (real subprocesses)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-abi-lock-race-'))
    try {
      const lockPath = defaultLockPath(dir)
      const tokens = Array.from({ length: 4 }, (_, i) => `tok-race-${i}`)
      // Every child runs the real acquireLock; the winner holds the lane for
      // 1500ms so the losers deterministically observe a live owner.
      const children = await Promise.all(tokens.map((token) => runChild([dir, lockPath, token, '1500'])))
      const results: { token: string; acquired: boolean; reason?: string }[] = children.map((child, i) => ({
        token: tokens[i],
        ...(JSON.parse(child.stdout) as { acquired: boolean; reason?: string })
      }))

      const winners = results.filter((r) => r.acquired === true)
      expect(winners.length).toBe(1)
      for (const loser of results.filter((r) => r.acquired === false)) {
        expect(loser.reason).toBe('locked')
      }
      for (const child of children) {
        expect(child.code).toBe(0)
      }
      // The surviving lock file carries the single winner's token.
      const held = parseLockFile(fs.readFileSync(lockPath, 'utf8'))
      expect(held?.owner.token).toBe(winners[0].token)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Bounded real-subprocess harness. Children import the real `lock.ts` (Node 24
// type stripping) and run `acquireLock` with the real `createLockFs` wiring —
// the real filesystem + `process.kill(pid, 0)` liveness — with no native
// binding involved.
// ---------------------------------------------------------------------------

const LOCK_TS_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lock.ts')).href

/**
 * Child script: acquire the checkout-scoped lane lock with the real LockFs
 * wiring, print the result as JSON, then exit. When a `holdMs` argument is
 * provided, an acquirer that won the lane holds it that long before exiting so
 * concurrent contenders deterministically observe a live owner.
 */
const CHILD_SCRIPT = `
import { acquireLock } from ${JSON.stringify(LOCK_TS_URL)}
// node -e argv layout: [execPath, arg1, arg2, ...]; argv[1] is the first real argument.
const [checkout, lockPath, token, holdMs] = process.argv.slice(1)
const result = await acquireLock({ checkoutRoot: checkout, lane: 'electron', token, timeoutMs: 0, lockPath })
console.log(JSON.stringify({ acquired: result.acquired, reason: result.acquired ? undefined : result.reason, pid: process.pid }))
if (result.acquired && holdMs !== undefined) {
  await new Promise((resolve) => setTimeout(resolve, Number(holdMs)))
}
process.exit(0)
`

interface ChildResult {
  code: number | null
  pid: number
  stdout: string
  stderr: string
}

function runChild(args: string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += String(d)))
    child.stderr.on('data', (d: Buffer) => (stderr += String(d)))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, pid: child.pid ?? -1, stdout, stderr }))
  })
}
