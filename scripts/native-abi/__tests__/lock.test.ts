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
  MAX_PUBLISH_TEMP_ATTEMPTS,
  parseLockFile,
  parseLockOwner,
  releaseLock,
  serializeLockFile,
  tempPublishPath
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
  /** Injected `writeTemp` failures by exact temp path (a partial remnant is left behind, as on a real failed write). */
  writeTempErrors = new Map<string, string>()
  /** Injected `linkTemp` failures by lock path (the temp link is left behind, as on a real failed link). */
  linkErrors = new Map<string, string>()
  removeErrors = new Map<string, string>()
  writeTempCalls: { tempPath: string; content: string }[] = []
  linkCalls: { tempPath: string; lockPath: string }[] = []
  /** Best-effort own-temp cleanups (kept apart from lock-target removals: temp hygiene is asserted via `tempKeys`). */
  removedTemps: string[] = []
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

  writeTemp(tempPath: string, content: string): 'written' | 'exists' | string {
    this.writeTempCalls.push({ tempPath, content })
    const error = this.writeTempErrors.get(tempPath)
    if (error !== undefined) {
      this.writeTempErrors.delete(tempPath)
      // A failed real write may leave a partial temp behind; the policy must
      // clean it up best-effort.
      this.files.set(tempPath, 'partial-temp-remnant')
      return error
    }
    if (this.files.has(tempPath)) {
      return 'exists'
    }
    this.files.set(tempPath, content)
    return 'written'
  }

  linkTemp(tempPath: string, lockPath: string): 'linked' | 'exists' | string {
    this.linkCalls.push({ tempPath, lockPath })
    const error = this.linkErrors.get(lockPath) ?? this.linkErrors.get(tempPath)
    if (error !== undefined) {
      this.linkErrors.delete(lockPath)
      this.linkErrors.delete(tempPath)
      return error
    }
    if (!this.files.has(tempPath)) {
      return `ENOENT: temp missing: ${tempPath}`
    }
    if (this.files.has(lockPath)) {
      return 'exists'
    }
    this.files.set(lockPath, this.files.get(tempPath)!)
    return 'linked'
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
      // Sibling publish temps are hygiene, not lock-target removals: track
      // them separately so `removedPaths` keeps meaning "the lock was deleted".
      if (p.includes('.tmp.')) {
        this.removedTemps.push(p)
      } else {
        this.removedPaths.push(p)
      }
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

/** Sibling temp keys currently present for the lock (a publisher's own temps must never leak). */
function tempKeys(fake: FakeLockFs): string[] {
  return [...fake.files.keys()].filter((k) => k.startsWith(`${LOCK}.tmp.`))
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

  it('reclaims a malformed orphan immediately with no waiting (atomic publish proves no live writer)', async () => {
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
    // Single attempt, no sleeping: the double malformed read is sufficient
    // proof under atomic publish.
    expect(fake.sleepCalls).toEqual([])
    expect(fake.removedPaths).toEqual([LOCK])
    expect(tempKeys(fake)).toEqual([])
  })

  it('reports a valid lock published during the malformed guard as contention (never deletes it)', async () => {
    const fake = new FakeLockFs()
    fake.files.set(LOCK, 'garbage-not-json')
    const fresh = owner({ pid: 888, token: 'tok-fresh', lane: 'node' })
    fake.alivePids.add(fresh.pid)
    // First read sees the orphan; the guard re-read sees a freshly published
    // live owner racing the reclaim.
    fake.scriptedReads = ['garbage-not-json', serializeLockFile(lockFile(fresh))]

    const result = await acquireLock({
      checkoutRoot: CHECKOUT,
      lane: 'node',
      pid: 123,
      token: 'tok-new',
      timeoutMs: 0,
      fs: fake
    })

    expect(result).toEqual({ acquired: false, reason: 'locked', owner: fresh, lockPath: LOCK })
    expect(fake.removedPaths).toEqual([])
    expect(fake.sleepCalls).toEqual([])
  })

  it('publishes atomically: a contender sees absent before the link and complete bytes after', () => {
    const fake = new FakeLockFs()
    const winner = owner({ pid: 7777, token: 'tok-winner', lane: 'electron' })
    const content = serializeLockFile(lockFile(winner))
    const temp = tempPublishPath(LOCK, winner, 0)

    // Winner mid-publish: temp fully written, lock target not yet linked.
    expect(fake.writeTemp(temp, content)).toBe('written')
    expect(fake.readFile(LOCK)).toEqual({ status: 'absent' })

    // Publish completes: the target appears with the complete bytes at once.
    expect(fake.linkTemp(temp, LOCK)).toBe('linked')
    expect(fake.readFile(LOCK)).toEqual({ status: 'ok', content })
    expect(parseLockFile(fake.files.get(LOCK))?.owner.token).toBe('tok-winner')
  })

  it('grants exactly one winner to two concurrent publishers (second link sees exists)', () => {
    const fake = new FakeLockFs()
    const first = owner({ pid: 111, token: 'tok-first', lane: 'node' })
    const second = owner({ pid: 222, token: 'tok-second', lane: 'node' })
    const tempA = tempPublishPath(LOCK, first, 0)
    const tempB = tempPublishPath(LOCK, second, 0)

    expect(fake.writeTemp(tempA, serializeLockFile(lockFile(first)))).toBe('written')
    expect(fake.writeTemp(tempB, serializeLockFile(lockFile(second)))).toBe('written')
    expect(fake.linkTemp(tempA, LOCK)).toBe('linked')
    // The loser observes contention — never a second winner.
    expect(fake.linkTemp(tempB, LOCK)).toBe('exists')
    expect(parseLockFile(fake.files.get(LOCK))?.owner.token).toBe('tok-first')
  })

  it('cleans up the loser temp on link contention and reports the live owner without waiting', async () => {
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
    expect(tempKeys(fake)).toEqual([])
  })

  it('surfaces a temp write failure as an observable error and cleans the partial temp', async () => {
    const fake = new FakeLockFs()
    const me = owner({ pid: 9, token: 'tok-w', lane: 'node' })
    fake.writeTempErrors.set(tempPublishPath(LOCK, me, 0), 'ENOSPC: no space left on device')

    const result = await acquireLock({
      checkoutRoot: CHECKOUT,
      lane: 'node',
      pid: me.pid,
      token: me.token,
      timeoutMs: 0,
      fs: fake
    })

    expect(result).toEqual({
      acquired: false,
      reason: 'error',
      error: 'ENOSPC: no space left on device',
      lockPath: LOCK
    })
    expect(fake.files.has(LOCK)).toBe(false)
    expect(tempKeys(fake)).toEqual([])
    expect(fake.sleepCalls).toEqual([])
  })

  it('surfaces a link failure as an observable error and cleans the temp link', async () => {
    const fake = new FakeLockFs()
    fake.linkErrors.set(LOCK, 'EPERM: operation not permitted')

    const result = await acquireLock({
      checkoutRoot: CHECKOUT,
      lane: 'node',
      pid: 9,
      token: 'tok-link-fail',
      timeoutMs: 0,
      fs: fake
    })

    expect(result).toEqual({
      acquired: false,
      reason: 'error',
      error: 'EPERM: operation not permitted',
      lockPath: LOCK
    })
    expect(fake.files.has(LOCK)).toBe(false)
    expect(tempKeys(fake)).toEqual([])
    expect(fake.sleepCalls).toEqual([])
  })

  it('retries a collided temp name with the next suffix and never deletes the foreign temp', async () => {
    const fake = new FakeLockFs()
    const me = owner({ pid: 9, token: 'tok-collide', lane: 'node' })
    const foreignTemp = tempPublishPath(LOCK, me, 0)
    fake.files.set(foreignTemp, 'foreign-temp-body')

    const result = await acquireLock({
      checkoutRoot: CHECKOUT,
      lane: 'node',
      pid: me.pid,
      token: me.token,
      timeoutMs: 0,
      fs: fake
    })

    expect(result.acquired).toBe(true)
    expect(parseLockFile(fake.files.get(LOCK))?.owner.token).toBe(me.token)
    // The foreign temp we never owned is untouched; our own attempt-1 temp is cleaned.
    expect(fake.files.get(foreignTemp)).toBe('foreign-temp-body')
    expect(tempKeys(fake)).toEqual([foreignTemp])
    expect(fake.sleepCalls).toEqual([])
  })

  it('requires the atomic link pair at compile time (a seam without it must not construct)', () => {
    const full = new FakeLockFs()
    const incomplete = full as unknown as Omit<LockFs, 'writeTemp' | 'linkTemp'>
    // @ts-expect-error — LockFs requires writeTemp/linkTemp; a seam without the
    // atomic-publish pair must fail typecheck so production can never silently
    // downgrade to a partial-visible write.
    const mustNotCompile: LockFs = incomplete
    expect(mustNotCompile).toBe(incomplete)
  })

  it(`fails closed after bounded temp collisions (at most ${MAX_PUBLISH_TEMP_ATTEMPTS} attempts)`, async () => {
    const fake = new FakeLockFs()
    const me = owner({ pid: 7, token: 'tok-storm', lane: 'node' })
    for (let attempt = 0; attempt < MAX_PUBLISH_TEMP_ATTEMPTS; attempt++) {
      fake.files.set(tempPublishPath(LOCK, me, attempt), 'foreign-temp-body')
    }

    const result = await acquireLock({
      checkoutRoot: CHECKOUT,
      lane: 'node',
      pid: me.pid,
      token: me.token,
      timeoutMs: 0,
      fs: fake
    })

    expect(result).toEqual({
      acquired: false,
      reason: 'error',
      error: expect.stringContaining('too many temp files'),
      lockPath: LOCK
    })
    expect(fake.files.has(LOCK)).toBe(false)
    expect(fake.sleepCalls).toEqual([])
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

  it('ignores crash-leftover publish temps without any runtime scan', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
    const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')
    expect(gitignore.split(/\r?\n/)).toContain(`${LOCK_FILE_NAME}.tmp.*`)
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
      // Atomic publish leaves no sibling temp behind.
      expect(fs.readdirSync(dir).filter((entry) => entry.startsWith(`${LOCK_FILE_NAME}.tmp.`))).toEqual([])

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
      expect(child.code, `child stderr: ${child.stderr} stdout: ${child.stdout}`).toBe(0)
      expect(parseChildResult(child, childToken).acquired).toBe(true)
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
      // Start barrier: all contenders are spawned before any is awaited, so
      // every child races while the winner holds the lane for 1500ms and the
      // losers deterministically observe a live owner (no fragile timing).
      const pending = tokens.map((token) => runChild([dir, lockPath, token, '1500']))
      const children = await Promise.all(pending)
      const diagnostics = children.map((child, i) => ({
        token: tokens[i],
        code: child.code,
        pid: child.pid,
        stdout: child.stdout,
        stderr: child.stderr
      }))
      const results: { token: string; acquired: boolean; reason?: string }[] = children.map((child, i) => ({
        token: tokens[i],
        ...(parseChildResult(child, tokens[i]) as { acquired: boolean; reason?: string })
      }))

      const winners = results.filter((r) => r.acquired === true)
      expect(winners.length, `expected exactly one winner; diagnostics: ${JSON.stringify(diagnostics)}`).toBe(1)
      for (const loser of results.filter((r) => r.acquired === false)) {
        expect(loser.reason, `loser diagnostics: ${JSON.stringify(diagnostics)}`).toBe('locked')
      }
      for (const [i, child] of children.entries()) {
        expect(child.code, `child ${tokens[i]} stderr: ${child.stderr} stdout: ${child.stdout}`).toBe(0)
      }
      // The surviving lock file carries the single winner's token, and no
      // contender leaked a sibling temp publish file.
      const held = parseLockFile(fs.readFileSync(lockPath, 'utf8'))
      expect(held?.owner.token, `winner diagnostics: ${JSON.stringify(diagnostics)}`).toBe(winners[0].token)
      expect(
        fs.readdirSync(dir).filter((entry) => entry.startsWith(`${LOCK_FILE_NAME}.tmp.`)),
        `temp leftovers; diagnostics: ${JSON.stringify(diagnostics)}`
      ).toEqual([])
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

/**
 * Parse a child acquire result, surfacing the full child diagnostics (exit
 * code, pid, stdout, stderr) when the child printed no parseable JSON instead
 * of throwing a bare SyntaxError.
 */
function parseChildResult(child: ChildResult, token: string): { acquired: boolean; reason?: string } {
  try {
    return JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '') as { acquired: boolean; reason?: string }
  } catch (err) {
    throw new Error(
      `child ${token} (pid ${child.pid}, code ${String(child.code)}) produced no JSON: ${err instanceof Error ? err.message : String(err)}; stdout=${JSON.stringify(child.stdout)} stderr=${JSON.stringify(child.stderr)}`
    )
  }
}
