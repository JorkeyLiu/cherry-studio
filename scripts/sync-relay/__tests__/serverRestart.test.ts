/**
 * Bounded Node-lane spike: real reference relay CLI (`scripts/sync-relay/server.ts`)
 * as an owned child process — file-backed startup, push/pull, bounded SIGTERM
 * process stop, SIGTERM process restart with the same database, cursor/operation
 * retention, exact cleanup.
 *
 * Limited validation slice only (not production infrastructure). The test runner
 * never imports better-sqlite3: the child runs under the pinned Node/tsx runtime
 * and owns the SQLite binding. Only the owned child PID is ever terminated and
 * only the owned temp root is ever removed (fail-closed). The server CLI has no
 * SIGTERM handler and performs no clean db.close on SIGTERM; evidence covers only
 * bounded SIGTERM process restart, not hard-kill WAL durability or production
 * deployment.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const SERVER_ENTRY = resolve(process.cwd(), 'scripts/sync-relay/server.ts')
const TSX_ENTRY = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs')
const TOKEN = 'restart-spike-token'
const START_TIMEOUT_MS = 15000
const HEALTH_TIMEOUT_MS = 10000
const HEALTH_INTERVAL_MS = 100
const REQUEST_TIMEOUT_MS = 5000
const STOP_TIMEOUT_MS = 5000
const READINESS_RE = /\[sync-relay\] listening on (http:\/\/127\.0\.0\.1:\d+)/

interface RelayChild {
  child: ChildProcess
  baseUrl: string
}

function buildOp(n: number, timestamp: number) {
  return {
    id: `spike-op-${n}`,
    entityType: 'topic',
    op: 'upsert',
    entityId: `spike-topic-${n}`,
    timestamp,
    deviceId: 'spike-device-1',
    payload: { id: `spike-topic-${n}`, name: `Spike Topic ${n}` }
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      rejectExit(new Error('timed out waiting for relay child exit'))
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolveExit()
    }
    child.once('exit', onExit)
  })
}

function fetchWithTimeout(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
}

function isChildGone(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function asCleanupError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

async function stopChildBounded(child: ChildProcess): Promise<void> {
  if (isChildGone(child)) return
  try {
    child.kill('SIGTERM')
  } catch (e) {
    if (isChildGone(child)) return
    throw new Error(`failed to SIGTERM owned relay child (pid=${child.pid}): ${(e as Error).message}`)
  }
  try {
    await waitForExit(child, STOP_TIMEOUT_MS)
  } catch {
    try {
      child.kill('SIGKILL')
    } catch (e) {
      if (isChildGone(child)) return
      throw new Error(`failed to SIGKILL owned relay child (pid=${child.pid}): ${(e as Error).message}`)
    }
    try {
      await waitForExit(child, STOP_TIMEOUT_MS)
    } catch (e) {
      throw new Error(`owned relay child still alive after SIGTERM/SIGKILL (pid=${child.pid}): ${(e as Error).message}`)
    }
  }
  if (!isChildGone(child)) {
    throw new Error(`owned relay child still alive after bounded stop (pid=${child.pid})`)
  }
}

function startRelay(dbPath: string, onSpawn?: (child: ChildProcess) => void): Promise<RelayChild> {
  return new Promise((resolveStart, rejectStart) => {
    const child = spawn(process.execPath, [TSX_ENTRY, SERVER_ENTRY, '--port', '0', '--db', dbPath, '--token', TOKEN], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // Retain child ownership immediately after spawn so a readiness/startup
    // failure can never remove the owned root while the child remains alive.
    onSpawn?.(child)
    let output = ''
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Bounded stop/escalation/await before rejecting: SIGTERM, await exit,
      // escalate to SIGKILL on timeout, await again. Owned PID only.
      // Preserve the original startup error while aggregating cleanup failure.
      void stopChildBounded(child).then(
        () => rejectStart(err),
        (cleanupErr: unknown) =>
          rejectStart(
            new AggregateError([err, asCleanupError(cleanupErr)], 'relay startup failed; cleanup also failed')
          )
      )
    }
    const timer = setTimeout(
      () => fail(new Error(`relay did not report readiness within ${START_TIMEOUT_MS}ms: ${output.slice(0, 500)}`)),
      START_TIMEOUT_MS
    )
    // Fail-closed: clear the timer exactly once when the child settles.
    timer.unref?.()
    child.on('error', (err) => fail(err))
    child.on('exit', (code, signal) => {
      if (!settled)
        fail(new Error(`relay child exited before readiness (code=${code} signal=${signal}): ${output.slice(0, 500)}`))
    })
    const onData = (chunk: Buffer) => {
      if (settled) return
      output += chunk.toString('utf8')
      const match = READINESS_RE.exec(output)
      if (match) {
        settled = true
        clearTimeout(timer)
        child.stdout?.removeListener('data', onData)
        resolveStart({ child, baseUrl: match[1] })
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
  })
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/health`, undefined, REQUEST_TIMEOUT_MS)
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean }
        if (body.ok === true) return
        lastErr = 'health body not ok'
      } else {
        lastErr = `health status ${res.status}`
      }
    } catch (e) {
      lastErr = (e as Error).message
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS))
  }
  throw new Error(`relay health check timed out: ${lastErr.slice(0, 300)}`)
}

async function stopRelayProcess(child: ChildProcess): Promise<void> {
  await stopChildBounded(child)
}

async function pushOps(
  baseUrl: string,
  ops: unknown[],
  token: string = TOKEN
): Promise<{ acceptedIds: string[]; cursor: number; status: number }> {
  const res = await fetchWithTimeout(
    `${baseUrl}/sync/push`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ deviceId: 'spike-device-1', operations: ops })
    },
    REQUEST_TIMEOUT_MS
  )
  const body = (await res.json()) as { acceptedIds?: string[]; cursor?: number }
  return { acceptedIds: body.acceptedIds ?? [], cursor: body.cursor ?? -1, status: res.status }
}

async function pullOps(baseUrl: string, cursor: number, token: string = TOKEN) {
  const res = await fetchWithTimeout(
    `${baseUrl}/sync/pull?cursor=${cursor}`,
    {
      headers: { Authorization: `Bearer ${token}` }
    },
    REQUEST_TIMEOUT_MS
  )
  const body = (await res.json()) as { operations?: any[]; cursor?: number }
  return { status: res.status, operations: body.operations ?? [], cursor: body.cursor ?? -1 }
}

describe('sync relay CLI restart spike', () => {
  let root: string | undefined
  let active: ChildProcess | undefined

  afterEach(async () => {
    // Exact cleanup: only the owned child PID, only the owned root.
    // The owned root is removed only after owned-child absence is verified
    // (fail-closed: a live child retains its root and fails the test).
    // Stop and removal failures are aggregated while preserving each error.
    const errors: Error[] = []
    const owned = active
    active = undefined
    if (owned) {
      try {
        await stopChildBounded(owned)
      } catch (e) {
        errors.push(asCleanupError(e))
      }
      if (!isChildGone(owned)) {
        errors.push(new Error(`owned relay child still alive (pid=${owned.pid}); owned root retained fail-closed`))
      }
    }
    const childAlive = owned !== undefined && !isChildGone(owned)
    if (root) {
      if (childAlive) {
        // Retain the owned root while the child may still be alive.
      } else {
        try {
          rmSync(root, { recursive: true, force: true })
          expect(existsSync(root)).toBe(false)
          root = undefined
        } catch (e) {
          errors.push(asCleanupError(e))
        }
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'relay restart cleanup failed')
  })

  it('retains operations and cursor across SIGTERM process restart with the same db', async () => {
    root = mkdtempSync(join(tmpdir(), 'sync-relay-restart-'))
    const dbPath = join(root, 'relay.db')

    // --- First boot: file-backed startup + health + push/pull ---
    const first = await startRelay(dbPath, (c) => {
      active = c
    })
    try {
      await waitForHealth(first.baseUrl)
      expect(existsSync(dbPath)).toBe(true)

      const op1 = buildOp(1, 1700000000001)
      const op2 = buildOp(2, 1700000000002)
      const pushRes = await pushOps(first.baseUrl, [op1, op2])
      expect(pushRes.status).toBe(200)
      expect(pushRes.acceptedIds).toEqual(['spike-op-1', 'spike-op-2'])
      expect(pushRes.cursor).toBe(2)

      const pullRes = await pullOps(first.baseUrl, 0)
      expect(pullRes.status).toBe(200)
      expect(pullRes.cursor).toBe(2)
      expect(pullRes.operations.map((o) => o.id)).toEqual(['spike-op-1', 'spike-op-2'])
      expect(pullRes.operations.map((o) => o.seq)).toEqual([1, 2])
      expect(pullRes.operations[0].payload).toMatchObject({ id: 'spike-topic-1', name: 'Spike Topic 1' })

      // Wrong token is rejected (does not mutate the log).
      const badPush = await fetchWithTimeout(
        `${first.baseUrl}/sync/push`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
          body: JSON.stringify({ deviceId: 'spike-device-1', operations: [buildOp(9, 1700000000009)] })
        },
        REQUEST_TIMEOUT_MS
      )
      expect(badPush.status).toBe(401)
      const badPull = await fetchWithTimeout(
        `${first.baseUrl}/sync/pull?cursor=0`,
        {
          headers: { Authorization: 'Bearer wrong-token' }
        },
        REQUEST_TIMEOUT_MS
      )
      expect(badPull.status).toBe(401)
    } finally {
      await stopRelayProcess(first.child)
      active = undefined
    }
    expect(first.child.exitCode !== null || first.child.signalCode !== null).toBe(true)

    // --- SIGTERM process restart with the same DB/token: old ops retained, sequence continues ---
    const second = await startRelay(dbPath, (c) => {
      active = c
    })
    try {
      await waitForHealth(second.baseUrl)

      const retained = await pullOps(second.baseUrl, 0)
      expect(retained.status).toBe(200)
      expect(retained.cursor).toBe(2)
      expect(retained.operations.map((o) => o.id)).toEqual(['spike-op-1', 'spike-op-2'])
      expect(retained.operations.map((o) => o.seq)).toEqual([1, 2])

      const op3 = buildOp(3, 1700000000003)
      const push3 = await pushOps(second.baseUrl, [op3])
      expect(push3.status).toBe(200)
      expect(push3.acceptedIds).toEqual(['spike-op-3'])
      expect(push3.cursor).toBe(3)

      const delta = await pullOps(second.baseUrl, 2)
      expect(delta.status).toBe(200)
      expect(delta.cursor).toBe(3)
      expect(delta.operations.map((o) => o.id)).toEqual(['spike-op-3'])
      expect(delta.operations.map((o) => o.seq)).toEqual([3])

      const full = await pullOps(second.baseUrl, 0)
      expect(full.operations.map((o) => o.seq)).toEqual([1, 2, 3])
      expect(full.cursor).toBe(3)
    } finally {
      await stopRelayProcess(second.child)
      active = undefined
    }
    expect(second.child.exitCode !== null || second.child.signalCode !== null).toBe(true)
    // Owned-root removal is asserted in afterEach (fail-closed exact cleanup).
  }, 60000)
})
