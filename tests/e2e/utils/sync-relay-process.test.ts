/**
 * Lifecycle tests for the file-backed reference relay child.
 *
 * The runner stays ABI-neutral (no better-sqlite3 import); the native
 * binding loads only in the owned Electron-as-Node child (ABI 145).
 * Covers: startup/readiness, authenticated push/pull, wrong-token 401
 * without state mutation, bounded stop/restart on the same DB with retained
 * cursor/seq and sequence continuity, and exact fail-closed cleanup.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createOwnedTmpRoot, removeOwnedTmpRoot } from './run-ownership'
import {
  assertNoLiveRelayChild,
  assertNoUnresolvedRelayCleanup,
  assertRestartPortContinuity,
  fetchRelayHealthOnce,
  getFailedRelayHandle,
  hasLiveRelayChild,
  hasUnresolvedRelayCleanup,
  startFileBackedRelay,
  validateRelayTimeoutMs,
  waitForRelayHealth,
  type FileBackedRelayHandle
} from './sync-relay-process'

const TOKEN = 'relay-process-test-token'

const require = createRequire(import.meta.url)

/**
 * ABI probe: can the installed Electron binary load better-sqlite3 from the
 * repo node_modules (the exact resolution path the relay child uses via
 * NODE_PATH)? Under supported Node-lane invocations (`pnpm test` /
 * `pnpm test:e2e-utils`) the checkout binding is Node ABI137, so these
 * lifecycle assertions intentionally skip there — a deliberate, non-flaky
 * skip. The integrated Electron-ABI proof runs under the canonical
 * `pnpm test:e2e` (Electron ABI145 lane) and in the relay-restart E2E spec.
 * The runner itself never imports better-sqlite3; only the Electron child
 * loads the native binding.
 */
const ABI_MISMATCH_PATTERN = /NODE_MODULE_VERSION|was compiled against a different/i

/**
 * Strict ABI probe: only an explicitly detected Node-ABI binding mismatch
 * becomes a skip. Spawn/timeout/missing-binary/missing-module/readiness and
 * any other unexpected failure throws, so infrastructure breakage fails
 * instead of silently skipping.
 */
function probeElectronAbiStrict(): { ok: boolean; mismatch: boolean } {
  const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'e2e-relay-abi-probe-'))
  try {
    const scriptPath = path.join(tmpDir, 'abi-probe.js')
    fs.writeFileSync(
      scriptPath,
      `const Database = require('better-sqlite3');\n` +
        `const db = new Database(':memory:');\n` +
        `const ok = db.prepare('select 1 as ok').get().ok;\n` +
        `db.close();\n` +
        `console.log(JSON.stringify({ ok: ok === 1 }));\n`
    )
    let electronPath: string
    try {
      electronPath = require('electron') as string
    } catch (e) {
      throw new Error(
        `relay ABI probe: electron binary resolution failed (${String((e as Error).message).slice(0, 200)})`
      )
    }
    if (!electronPath || typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
      throw new Error('relay ABI probe: electron binary missing')
    }
    const repoRoot = fs.realpathSync(process.cwd())
    const nodeModulesPath = path.join(repoRoot, 'node_modules')
    if (!fs.existsSync(path.join(nodeModulesPath, 'better-sqlite3'))) {
      throw new Error('relay ABI probe: better-sqlite3 module missing')
    }
    const result = spawnSync(electronPath, [scriptPath], {
      timeout: 60000,
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        TMPDIR: tmpDir,
        TMP: tmpDir,
        TEMP: tmpDir,
        NODE_PATH: nodeModulesPath
      }
    })
    const combined = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`
    if (result.error) {
      if (ABI_MISMATCH_PATTERN.test(combined) || ABI_MISMATCH_PATTERN.test(String(result.error.message))) {
        return { ok: false, mismatch: true }
      }
      throw new Error(`relay ABI probe spawn failed (${String(result.error.message).slice(0, 200)})`)
    }
    if (combined.includes('"ok":true') && result.status === 0) return { ok: true, mismatch: false }
    if (ABI_MISMATCH_PATTERN.test(combined)) return { ok: false, mismatch: true }
    throw new Error(
      `relay ABI probe failed (status=${result.status} stdout=${String(result.stdout ?? '').slice(-300)} stderr=${String(result.stderr ?? '').slice(-300)})`
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// Throws on infrastructure failure (fail, never skip); only an explicit
// Node-ABI mismatch becomes a skip via describe.skipIf below.
const abiProbe = probeElectronAbiStrict()
console.log(
  `[E2E] relay-process ABI probe: ${abiProbe.ok ? 'PASS (Electron ABI145 binding)' : 'SKIP (expected Node-ABI mismatch)'}`
)

function topicOp(id: string, entityId: string, name = 'N', ts = 1000): Record<string, unknown> {
  return {
    id,
    entityType: 'topic',
    op: 'upsert',
    entityId,
    timestamp: ts,
    deviceId: 'd1',
    payload: { id: entityId, name }
  }
}

let ownedTmpRoot: string | null = null
let relay: FileBackedRelayHandle | null = null

let deviceAuthState: string | undefined

async function pushRaw(
  endpoint: string,
  ops: Record<string, unknown>[],
  token: string | null
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-sync-device-id': 'd1' }
  if (token !== null) headers.Authorization = `Bearer ${token}`
  if (deviceAuthState) headers['x-sync-device-auth'] = deviceAuthState
  const res = await fetch(`${endpoint}/sync/push`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ deviceId: 'd1', operations: ops })
  })
  const body = await res.json().catch(() => ({}))
  if (typeof body?.deviceAuth === 'string') deviceAuthState = body.deviceAuth
  return { status: res.status, body }
}

async function pullRaw(
  endpoint: string,
  cursor: number,
  token: string | null = TOKEN
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'x-sync-device-id': 'd1' }
  if (token !== null) headers.Authorization = `Bearer ${token}`
  if (deviceAuthState) headers['x-sync-device-auth'] = deviceAuthState
  const res = await fetch(`${endpoint}/sync/pull?cursor=${cursor}&deviceId=d1`, { headers })
  const body = await res.json().catch(() => ({}))
  if (typeof body?.deviceAuth === 'string') deviceAuthState = body.deviceAuth
  return { status: res.status, body }
}

async function startTrackedRelay(args: Parameters<typeof startFileBackedRelay>[0]): Promise<FileBackedRelayHandle> {
  try {
    return await startFileBackedRelay(args)
  } catch (e) {
    // Retain the owned handle from a failed start so teardown can stop/close
    // the exact child instead of orphaning it; the global registry also
    // blocks root removal while the child lives.
    const failed = getFailedRelayHandle(e)
    if (failed) relay = failed
    throw e
  }
}

describe.skipIf(!abiProbe.ok)('file-backed relay child lifecycle', () => {
  // Guard: the skip above fires ONLY for the explicit mismatch probe. Any
  // probe throw fails file collection before reaching here.
  it('probe gate is reachable only on Electron ABI or explicit mismatch', () => {
    expect(abiProbe.ok).toBe(true)
  })
  beforeEach(() => {
    ownedTmpRoot = createOwnedTmpRoot()
    deviceAuthState = undefined
  })

  afterEach(async () => {
    let closeError: unknown = null
    if (relay) {
      try {
        await relay.close()
      } catch (e) {
        closeError = e
        // Retry once only when the child is already stopped (safe); when the
        // child is still live the handle is retained and the root is preserved
        // below instead of retry-looping against a live child.
        try {
          if (!relay.isRunning()) await relay.close()
          else relay = relay
        } catch {}
      }
    }
    const liveBeforeRootRemoval = relay ? safeIsRunning(relay) : hasLiveRelayChild()
    if (liveBeforeRootRemoval) {
      // Fail-closed: a live owned child blocks root removal. Preserve the
      // root for retry/reporting and surface both close and liveness errors.
      const liveErr = new Error('sync-relay-process test teardown: live relay child blocks owned root removal')
      relay = null
      if (closeError) throw new AggregateError([asError(closeError), liveErr], 'relay teardown failed; root preserved')
      try {
        assertNoLiveRelayChild('test owned root removal')
      } catch (e) {
        throw new AggregateError([asError(e)], 'relay teardown failed; root preserved')
      }
      throw liveErr
    }
    relay = null
    if (ownedTmpRoot) {
      try {
        try {
          assertNoUnresolvedRelayCleanup('test owned root removal')
        } catch (e) {
          throw new AggregateError(
            [asError(e)],
            `relay test owned root preserved (unresolved relay ownership): ${ownedTmpRoot}`
          )
        }
        assertNoLiveRelayChild('test owned root removal')
        await removeOwnedTmpRoot(ownedTmpRoot, [])
      } catch (e) {
        if (closeError) throw new AggregateError([asError(closeError), asError(e)], 'relay teardown failed')
        throw e
      }
      if (closeError) throw closeError
      ownedTmpRoot = null
    } else if (closeError) {
      throw closeError
    }
  })

  function asError(e: unknown): Error {
    return e instanceof Error ? e : new Error(String(e))
  }

  function safeIsRunning(handle: FileBackedRelayHandle): boolean {
    try {
      return handle.isRunning()
    } catch {
      return true
    }
  }

  it('starts under the Electron lane and serves health plus authenticated push/pull', async () => {
    relay = await startTrackedRelay({ ownedTmpRoot: ownedTmpRoot as string, token: TOKEN })
    expect(relay.isRunning()).toBe(true)
    expect(relay.pid()).toBeGreaterThan(0)
    expect(relay.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const health = await fetch(`${relay.endpoint}/health`)
    expect(health.status).toBe(200)

    const pushed = await pushRaw(relay.endpoint, [topicOp('op-lc-1', 't-lc-1', 'One', 1000)], TOKEN)
    expect(pushed.status).toBe(200)
    expect(pushed.body.acceptedIds).toEqual(['op-lc-1'])

    const pulled = await pullRaw(relay.endpoint, 0, TOKEN)
    expect(pulled.status).toBe(200)
    expect(pulled.body.cursor).toBe(1)
    expect((pulled.body.operations as any[]).map((o) => o.id)).toEqual(['op-lc-1'])
    expect((pulled.body.operations as any[]).map((o) => o.seq)).toEqual([1])
  }, 90000)

  it('wrong-token requests stay 401 and do not mutate relay state', async () => {
    relay = await startTrackedRelay({ ownedTmpRoot: ownedTmpRoot as string, token: TOKEN })
    const seed = await pushRaw(relay.endpoint, [topicOp('op-auth-seed', 't-auth-seed', 'Seed', 1000)], TOKEN)
    expect(seed.status).toBe(200)

    const badPush = await pushRaw(relay.endpoint, [topicOp('op-auth-bad', 't-auth-bad', 'Bad', 1001)], 'wrong-token')
    expect(badPush.status).toBe(401)
    const noPush = await pushRaw(relay.endpoint, [topicOp('op-auth-none', 't-auth-none', 'None', 1002)], null)
    expect(noPush.status).toBe(401)
    const badPull = await pullRaw(relay.endpoint, 0, 'wrong-token')
    expect(badPull.status).toBe(401)
    const noPull = await pullRaw(relay.endpoint, 0, null)
    expect(noPull.status).toBe(401)

    // Rejected auth attempts never touch the log: cursor stays at the seed.
    const after = await pullRaw(relay.endpoint, 0, TOKEN)
    expect(after.status).toBe(200)
    expect(after.body.cursor).toBe(1)
    expect((after.body.operations as any[]).map((o) => o.id)).toEqual(['op-auth-seed'])
  }, 90000)

  it('identical replay is idempotent without duplicate seq', async () => {
    relay = await startTrackedRelay({ ownedTmpRoot: ownedTmpRoot as string, token: TOKEN })
    const op = topicOp('op-replay-1', 't-replay-1', 'Replay', 1000)
    const first = await pushRaw(relay.endpoint, [op], TOKEN)
    expect(first.status).toBe(200)
    expect(first.body.cursor).toBe(1)
    const replay = await pushRaw(relay.endpoint, [op], TOKEN)
    expect(replay.status).toBe(200)
    expect(replay.body.acceptedIds).toEqual(['op-replay-1'])
    // No duplicate seq: cursor stays at 1 and pull still yields a single seq-1 row.
    expect(replay.body.cursor).toBe(1)
    const pulled = await pullRaw(relay.endpoint, 0, TOKEN)
    expect(pulled.status).toBe(200)
    expect(pulled.body.cursor).toBe(1)
    expect((pulled.body.operations as any[]).map((o) => o.seq)).toEqual([1])
    expect((pulled.body.operations as any[]).map((o) => o.id)).toEqual(['op-replay-1'])
  }, 90000)

  it('mismatched same-ID collision is rejected with 409 and no mutation', async () => {
    relay = await startTrackedRelay({ ownedTmpRoot: ownedTmpRoot as string, token: TOKEN })
    const seed = await pushRaw(relay.endpoint, [topicOp('op-collide-1', 't-collide-1', 'Seed', 1000)], TOKEN)
    expect(seed.status).toBe(200)
    expect(seed.body.cursor).toBe(1)
    // Same ID with a different payload/timestamp collides rather than replays.
    const clash = await pushRaw(relay.endpoint, [topicOp('op-collide-1', 't-collide-1', 'Mutated', 9999)], TOKEN)
    expect(clash.status).toBe(409)
    const after = await pullRaw(relay.endpoint, 0, TOKEN)
    expect(after.status).toBe(200)
    expect(after.body.cursor).toBe(1)
    expect((after.body.operations as any[]).map((o) => o.seq)).toEqual([1])
    expect((after.body.operations as any[])[0].payload).toMatchObject({ name: 'Seed' })
  }, 90000)

  it('malformed operations are rejected with 400 and no mutation', async () => {
    relay = await startTrackedRelay({ ownedTmpRoot: ownedTmpRoot as string, token: TOKEN })
    const seed = await pushRaw(relay.endpoint, [topicOp('op-mal-seed', 't-mal-seed', 'Seed', 1000)], TOKEN)
    expect(seed.status).toBe(200)
    const badId = await pushRaw(relay.endpoint, [{ ...topicOp('op-mal-bad', 't-mal-bad', 'Bad', 1001), id: '' }], TOKEN)
    expect(badId.status).toBe(400)
    const badType = await pushRaw(
      relay.endpoint,
      [{ ...topicOp('op-mal-type', 't-mal-type', 'Bad', 1001), entityType: 'nope' }],
      TOKEN
    )
    expect(badType.status).toBe(400)
    const nonArray = await (async () => {
      const res = await fetch(`${relay!.endpoint}/sync/push`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TOKEN}`,
          'x-sync-device-id': 'd1',
          ...(deviceAuthState ? { 'x-sync-device-auth': deviceAuthState } : {})
        },
        body: JSON.stringify({ deviceId: 'd1', operations: 'not-an-array' })
      })
      return { status: res.status, body: await res.json().catch(() => ({})) }
    })()
    expect(nonArray.status).toBe(400)
    const after = await pullRaw(relay.endpoint, 0, TOKEN)
    expect(after.status).toBe(200)
    expect(after.body.cursor).toBe(1)
    expect((after.body.operations as any[]).map((o) => o.id)).toEqual(['op-mal-seed'])
  }, 90000)

  it('noncanonical/unsafe cursors are rejected and limits follow exact server behavior', async () => {
    relay = await startTrackedRelay({ ownedTmpRoot: ownedTmpRoot as string, token: TOKEN })
    const seed = await pushRaw(relay.endpoint, [topicOp('op-cur-1', 't-cur-1', 'Seed', 1000)], TOKEN)
    expect(seed.status).toBe(200)
    for (const bad of ['07', '00', '01', ' 1', '1 ', '12junk', '-1', 'abc', '1.5', '..', '%2e%2e']) {
      const res = await fetch(`${relay.endpoint}/sync/pull?cursor=${encodeURIComponent(bad)}&deviceId=d1`, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'x-sync-device-id': 'd1',
          ...(deviceAuthState ? { 'x-sync-device-auth': deviceAuthState } : {})
        }
      })
      await res.json().catch(() => ({}))
      expect(res.status, `cursor ${bad}`).toBe(400)
    }
    // Exact intentional limit behavior: noncanonical limit is 400, while
    // limit=0 falls back to the default window (200) instead of 400.
    const badLimit = await fetch(`${relay.endpoint}/sync/pull?cursor=0&deviceId=d1&limit=abc`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'x-sync-device-id': 'd1',
        ...(deviceAuthState ? { 'x-sync-device-auth': deviceAuthState } : {})
      }
    })
    await badLimit.json().catch(() => ({}))
    expect(badLimit.status).toBe(400)
    const zeroLimit = await fetch(`${relay.endpoint}/sync/pull?cursor=0&deviceId=d1&limit=0`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'x-sync-device-id': 'd1',
        ...(deviceAuthState ? { 'x-sync-device-auth': deviceAuthState } : {})
      }
    })
    const zeroBody = (await zeroLimit.json().catch(() => ({}))) as any
    expect(zeroLimit.status).toBe(200)
    expect(zeroBody.cursor).toBe(1)
    expect((zeroBody.operations as any[]).map((o) => o.id)).toEqual(['op-cur-1'])
    // State is untouched by rejected cursor/limit probes.
    const after = await pullRaw(relay.endpoint, 0, TOKEN)
    expect(after.status).toBe(200)
    expect(after.body.cursor).toBe(1)
  }, 90000)

  it('bounded stop/restart on the same DB retains operations/cursor and continues the sequence', async () => {
    relay = await startTrackedRelay({ ownedTmpRoot: ownedTmpRoot as string, token: TOKEN })
    const dbPath = relay.dbPath
    expect(fs.existsSync(dbPath)).toBe(true)
    const pidBefore = relay.pid()
    expect(pidBefore).toBeGreaterThan(0)

    const push1 = await pushRaw(relay.endpoint, [topicOp('op-rs-1', 't-rs-1', 'One', 1000)], TOKEN)
    expect(push1.status).toBe(200)
    const push2 = await pushRaw(relay.endpoint, [topicOp('op-rs-2', 't-rs-2', 'Two', 1001)], TOKEN)
    expect(push2.status).toBe(200)
    expect(push2.body.cursor).toBe(2)

    const endpointBefore = relay.endpoint
    await relay.stop()
    expect(relay.isRunning()).toBe(false)
    expect(relay.pid()).toBeNull()
    // DB files are retained across the stop (no durability claim beyond this).
    expect(fs.existsSync(dbPath)).toBe(true)
    await expect(fetch(`${endpointBefore}/health`)).rejects.toThrow()

    await relay.restart()
    expect(relay.isRunning()).toBe(true)
    expect(relay.pid()).toBeGreaterThan(0)
    // Same endpoint: the restart pins the first bound port.
    expect(relay.endpoint).toBe(endpointBefore)

    // Retained operations are contiguous from cursor 0 with cursor continuity.
    const retained = await pullRaw(relay.endpoint, 0, TOKEN)
    expect(retained.status).toBe(200)
    expect(retained.body.cursor).toBe(2)
    expect((retained.body.operations as any[]).map((o) => o.seq)).toEqual([1, 2])
    expect((retained.body.operations as any[]).map((o) => o.id)).toEqual(['op-rs-1', 'op-rs-2'])

    // The sequence continues after restart: next push lands at seq 3.
    const push3 = await pushRaw(relay.endpoint, [topicOp('op-rs-3', 't-rs-3', 'Three', 1002)], TOKEN)
    expect(push3.status).toBe(200)
    expect(push3.body.cursor).toBe(3)
    const tail = await pullRaw(relay.endpoint, 2, TOKEN)
    expect(tail.status).toBe(200)
    expect(tail.body.cursor).toBe(3)
    expect((tail.body.operations as any[]).map((o) => o.seq)).toEqual([3])
  }, 120000)

  it('failed restart keeps single ownership: no second tracked handle, one close resolves all', async () => {
    relay = await startTrackedRelay({ ownedTmpRoot: ownedTmpRoot as string, token: TOKEN })
    const rootDir = ownedTmpRoot as string
    await relay.stop()
    expect(relay.isRunning()).toBe(false)
    // Remove the bundled launcher so restart startup fails deterministically
    // (child exits before readiness); DB files stay for fail-closed close.
    const bundles = fs
      .readdirSync(rootDir)
      .filter((name) => name.startsWith('sync-relay-bundle-') && name.endsWith('.cjs'))
    expect(bundles.length).toBeGreaterThan(0)
    for (const name of bundles) fs.rmSync(path.join(rootDir, name), { force: true })
    let failure: unknown = null
    try {
      await relay.restart()
    } catch (e) {
      failure = e
    }
    expect(failure).not.toBeNull()
    // Single-owner invariant: the failure carries THIS handle, not a second one.
    expect(getFailedRelayHandle(failure)).toBe(relay)
    expect(relay.isRunning()).toBe(false)
    // Root removal stays blocked until the single owned handle closes.
    expect(hasUnresolvedRelayCleanup()).toBe(true)
    expect(() => assertNoUnresolvedRelayCleanup('restart-failure test root removal')).toThrow(/unresolved/)
    await relay.close()
    relay = null
    expect(hasUnresolvedRelayCleanup()).toBe(false)
    assertNoUnresolvedRelayCleanup('restart-failure test root removal')
    assertNoLiveRelayChild('restart-failure test root removal')
  }, 120000)

  it('close stops the exact owned child and removes bundle plus DB artifacts', async () => {
    relay = await startTrackedRelay({ ownedTmpRoot: ownedTmpRoot as string, token: TOKEN })
    const endpoint = relay.endpoint
    const dbPath = relay.dbPath
    expect(relay.isRunning()).toBe(true)

    await relay.close()
    expect(relay.isRunning()).toBe(false)
    await expect(fetch(`${endpoint}/health`)).rejects.toThrow()
    expect(fs.existsSync(dbPath)).toBe(false)
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false)
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false)
    const leftovers = fs
      .readdirSync(ownedTmpRoot as string)
      .filter((name) => name.startsWith('sync-relay-bundle-') && name.endsWith('.cjs'))
    expect(leftovers).toEqual([])
    relay = null
  }, 90000)

  it('close failure preserves artifacts and retryability (directory blocks DB removal)', async () => {
    relay = await startTrackedRelay({ ownedTmpRoot: ownedTmpRoot as string, token: TOKEN })
    const dbPath = relay.dbPath
    await relay.stop()
    expect(relay.isRunning()).toBe(false)
    // Replace the DB file with a non-empty directory so artifact removal
    // fails deterministically without touching process signaling.
    fs.rmSync(dbPath, { force: true })
    fs.mkdirSync(dbPath, { recursive: true })
    fs.writeFileSync(path.join(dbPath, 'blocker.txt'), 'block-close')
    await expect(relay.close()).rejects.toThrow(/close failed|survived/)
    // Artifacts preserved and retry still possible: handle is not closed.
    expect(fs.existsSync(dbPath)).toBe(true)
    expect(relay.isRunning()).toBe(false)
    // Clear the blocker and retry: close must now succeed and untrack.
    fs.rmSync(dbPath, { recursive: true, force: true })
    await relay.close()
    expect(fs.existsSync(dbPath)).toBe(false)
    relay = null
  }, 90000)
})

describe('file-backed relay failure paths (no Electron ABI required)', () => {
  it('rejects unsafe artifact file names before spawning a child', async () => {
    const root = createOwnedTmpRoot()
    try {
      const unsafe = ['../escape.cjs', 'a/b.cjs', 'a\\b.cjs', '/abs.cjs', '..', '.', '', `${'x'.repeat(256)}.cjs`]
      for (const name of unsafe) {
        await expect(startFileBackedRelay({ ownedTmpRoot: root, token: TOKEN, bundleFileName: name })).rejects.toThrow(
          /file name|absolute|separators|dot entry|too long|non-empty|traversal|bare/
        )
        await expect(startFileBackedRelay({ ownedTmpRoot: root, token: TOKEN, dbFileName: name })).rejects.toThrow(
          /file name|absolute|separators|dot entry|too long|non-empty|traversal|bare/
        )
      }
      // No artifact escaped the owned root and no live child was tracked.
      expect(hasLiveRelayChild()).toBe(false)
      for (const entry of fs.readdirSync(root)) {
        expect(entry).not.toContain('..')
      }
    } finally {
      assertNoUnresolvedRelayCleanup('unsafe-name test root removal')
      assertNoLiveRelayChild('unsafe-name test root removal')
      await removeOwnedTmpRoot(root, [])
    }
  })

  it('health readiness requires {ok:true} and rejects malformed bodies', async () => {
    const { createServer } = await import('node:http')
    const serve = (
      handler: (req: unknown, res: { writeHead: (s: number, h: unknown) => void; end: (b: string) => void }) => void
    ): Promise<{ url: string; close: () => Promise<void> }> =>
      new Promise((resolve) => {
        const server = createServer(handler as never)
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as { port: number }
          resolve({
            url: `http://127.0.0.1:${addr.port}`,
            close: () => new Promise((r) => server.close(() => r()))
          })
        })
      })
    const ok = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    try {
      await waitForRelayHealth(ok.url, 5000)
      await fetchRelayHealthOnce(ok.url, 2000)
    } finally {
      await ok.close()
    }
    const malformed = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('not-json{{{')
    })
    try {
      await expect(fetchRelayHealthOnce(malformed.url, 2000)).rejects.toThrow(/JSON|health/)
      await expect(waitForRelayHealth(malformed.url, 1000)).rejects.toThrow(/readiness timeout/)
    } finally {
      await malformed.close()
    }
    const missing = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false }))
    })
    try {
      await expect(fetchRelayHealthOnce(missing.url, 2000)).rejects.toThrow(/ok:true/)
    } finally {
      await missing.close()
    }
    const wrongStatus = await serve((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    try {
      await expect(fetchRelayHealthOnce(wrongStatus.url, 2000)).rejects.toThrow(/status 500/)
    } finally {
      await wrongStatus.close()
    }
  })

  it('health readiness is bounded by the total deadline and caps response bytes', async () => {
    const { createServer } = await import('node:http')
    // Slow server: total wait must resolve near the caller budget, not the
    // per-request ceiling.
    const slow = createServer((_req, res) => {
      setTimeout(() => {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch {}
      }, 8000)
    })
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()))
    const slowUrl = `http://127.0.0.1:${(slow.address() as { port: number }).port}`
    try {
      const start = Date.now()
      await expect(waitForRelayHealth(slowUrl, 1200)).rejects.toThrow(/readiness timeout/)
      expect(Date.now() - start).toBeLessThan(5000)
    } finally {
      await new Promise((r) => slow.close(() => r()))
    }
    // Oversized server: declared and actual bodies above the cap are rejected
    // before JSON parsing.
    const big = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, pad: 'x'.repeat(70000) }))
    })
    await new Promise<void>((r) => big.listen(0, '127.0.0.1', () => r()))
    const bigUrl = `http://127.0.0.1:${(big.address() as { port: number }).port}`
    try {
      await expect(fetchRelayHealthOnce(bigUrl, 2000)).rejects.toThrow(/oversized/)
    } finally {
      await new Promise((r) => big.close(() => r()))
    }
  })

  it('startup failure retains an owned handle that blocks root removal until closed', async () => {
    const root = createOwnedTmpRoot()
    let failed: FileBackedRelayHandle | null = null
    try {
      // Absurdly small budget forces a startup/readiness failure deterministically;
      // the owned bundle/child must remain tracked via the retained handle.
      await startFileBackedRelay({ ownedTmpRoot: root, token: TOKEN, readyTimeoutMs: 1 })
    } catch (e) {
      failed = getFailedRelayHandle(e)
      expect(failed).not.toBeNull()
    }
    try {
      expect(failed).not.toBeNull()
      // Fail-closed: root removal is blocked while the retained handle is
      // unresolved (live or reaped-but-uncleaned). The unresolved gate fires
      // in both cases; the live-only gate fires only while the child lives.
      expect(() => assertNoUnresolvedRelayCleanup('startup-failure test root removal')).toThrow(/unresolved/)
      expect(hasUnresolvedRelayCleanup()).toBe(true)
      if (failed!.isRunning()) {
        expect(() => assertNoLiveRelayChild('startup-failure test root removal')).toThrow(/blocked while/)
      }
      await failed!.close()
      failed = null
      expect(hasUnresolvedRelayCleanup()).toBe(false)
      assertNoUnresolvedRelayCleanup('startup-failure test root removal')
      assertNoLiveRelayChild('startup-failure test root removal')
    } finally {
      if (failed) {
        // Unresolved ownership preserved: do not delete the root out from
        // under the retained handle; surface both errors.
        const gateError = new Error('relay test owned root preserved (unresolved relay ownership)')
        throw new AggregateError([gateError], `relay test owned root preserved: ${root}`)
      }
      assertNoUnresolvedRelayCleanup('startup-failure test root removal')
      await removeOwnedTmpRoot(root, [])
    }
  })

  it('rejects invalid timeout values before any readiness/stop loop', async () => {
    const root = createOwnedTmpRoot()
    try {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, -100]) {
        await expect(startFileBackedRelay({ ownedTmpRoot: root, token: TOKEN, readyTimeoutMs: bad })).rejects.toThrow(
          /finite positive timeout/
        )
        await expect(startFileBackedRelay({ ownedTmpRoot: root, token: TOKEN, stopTimeoutMs: bad })).rejects.toThrow(
          /finite positive timeout/
        )
      }
      await expect(startFileBackedRelay({ ownedTmpRoot: root, token: TOKEN, readyTimeoutMs: 300001 })).rejects.toThrow(
        /finite positive timeout/
      )
      await expect(waitForRelayHealth('http://127.0.0.1:1', Number.NaN)).rejects.toThrow(/finite positive timeout/)
      await expect(waitForRelayHealth('http://127.0.0.1:1', Number.POSITIVE_INFINITY)).rejects.toThrow(
        /finite positive timeout/
      )
      await expect(fetchRelayHealthOnce('http://127.0.0.1:1', 0)).rejects.toThrow(/finite positive timeout/)
      expect(() => validateRelayTimeoutMs('readyTimeoutMs', Number.NaN)).toThrow(/finite positive timeout/)
      // No child was tracked by any rejected input; root removal stays open.
      expect(hasLiveRelayChild()).toBe(false)
      expect(hasUnresolvedRelayCleanup()).toBe(false)
      assertNoUnresolvedRelayCleanup('invalid-timeout test root removal')
    } finally {
      assertNoUnresolvedRelayCleanup('invalid-timeout test root removal')
      assertNoLiveRelayChild('invalid-timeout test root removal')
      await removeOwnedTmpRoot(root, [])
    }
  })

  it('rejects DB sidecar symlinks (including dangling) before spawn', async () => {
    const root = createOwnedTmpRoot()
    try {
      const dbFileName = 'sidecar-guard.db'
      const outside = createOwnedTmpRoot()
      try {
        // External target lives INSIDE the separately owned root so owned
        // cleanup removes it; no sibling artifact outside owned roots.
        const outsideTarget = path.join(outside, 'external-target.txt')
        fs.writeFileSync(outsideTarget, 'outside')
        const clearStaleLink = (target: string): void => {
          try {
            fs.unlinkSync(target)
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
            throw new Error(
              `sidecar test setup cleanup failed for ${path.basename(target)} (${String((e as Error).message).slice(0, 120)})`
            )
          }
          try {
            fs.lstatSync(target)
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
            throw e
          }
          throw new Error(`sidecar test setup cleanup failed: ${path.basename(target)} still exists`)
        }
        const removeLinkAndVerifyAbsent = (target: string): void => {
          try {
            fs.unlinkSync(target)
          } catch (e) {
            throw new Error(
              `sidecar test link removal failed for ${path.basename(target)} (${String((e as Error).message).slice(0, 120)})`
            )
          }
          try {
            fs.lstatSync(target)
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
            throw e
          }
          throw new Error(`sidecar test link survived removal: ${path.basename(target)}`)
        }
        const assertLstatAbsent = (target: string): void => {
          try {
            fs.lstatSync(target)
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
            throw e
          }
          throw new Error(`sidecar test unexpected artifact present: ${path.basename(target)}`)
        }
        for (const suffix of ['-wal', '-shm', '-journal'] as const) {
          const linkPath = path.join(root, `${dbFileName}${suffix}`)
          clearStaleLink(linkPath)
          fs.symlinkSync(outsideTarget, linkPath)
          await expect(startFileBackedRelay({ ownedTmpRoot: root, token: TOKEN, dbFileName })).rejects.toThrow(
            /symlink/
          )
          removeLinkAndVerifyAbsent(linkPath)
          // Dangling symlink (target absent) is also rejected via lstat.
          const danglingTarget = path.join(root, `dangling-${suffix}-target`)
          assertLstatAbsent(danglingTarget)
          clearStaleLink(linkPath)
          fs.symlinkSync(danglingTarget, linkPath)
          await expect(startFileBackedRelay({ ownedTmpRoot: root, token: TOKEN, dbFileName })).rejects.toThrow(
            /symlink/
          )
          removeLinkAndVerifyAbsent(linkPath)
          assertLstatAbsent(danglingTarget)
        }
        expect(hasUnresolvedRelayCleanup()).toBe(false)
        expect(hasLiveRelayChild()).toBe(false)
      } finally {
        assertNoUnresolvedRelayCleanup('sidecar test outside root removal')
        await removeOwnedTmpRoot(outside, [])
      }
    } finally {
      assertNoUnresolvedRelayCleanup('sidecar test root removal')
      assertNoLiveRelayChild('sidecar test root removal')
      await removeOwnedTmpRoot(root, [])
    }
  })

  it('restart port continuity guard compares against the captured expected port', () => {
    expect(() => assertRestartPortContinuity(1234, 1234)).not.toThrow()
    expect(() => assertRestartPortContinuity(1234, 5678)).toThrow(/unexpected port/)
    expect(() => assertRestartPortContinuity(1, 2)).toThrow(/expected 1, got 2/)
  })
})
