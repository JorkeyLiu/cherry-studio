/**
 * Registration/channel/pairing protocol regressions (SYNC-CC-*, focused Node lane).
 *
 * Live reference relay (`scripts/sync-relay/server.ts`) over loopback HTTP
 * with an in-memory database:
 * - Explicit registration issues a stable public code + durable secret; the
 *   code carries no authorization; unknown credentials fail closed and are
 *   never silently re-registered.
 * - Pair-request lifecycle: idempotent retry, replacement, requester cancel,
 *   target accept/reject, no expiry.
 * - Atomic membership rules: unpaired+unpaired create, unpaired joins paired
 *   target, paired requester fails, late accept after requester paired fails
 *   with no merge.
 * - Unpair removes only self; sub-two membership dissolves; the survivor
 *   observes unpaired. Zombie rows never block.
 * - push/pull/SSE require paired membership, are isolated per channel, and
 *   sequence contiguously per channel.
 */
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

import { ensureRelaySchema } from '../../../../../scripts/sync-relay/server'
import { runRelayConformanceCore } from '../../../../../tests/e2e/utils/sync-relay-conformance'

const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/
const SECRET_RE = /^[0-9a-f]{64}$/

interface Registered {
  code: string
  secret: string
}

async function listenRelay(token?: string): Promise<{
  base: string
  db: Database.Database
  close: () => Promise<void>
}> {
  const { createRelayServer } = await import('../../../../../scripts/sync-relay/server')
  const db = new Database(':memory:')
  ensureRelaySchema(db)
  const server = createRelayServer(db, token ? { token } : {})
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as { port: number }
  return {
    base: `http://127.0.0.1:${addr.port}`,
    db,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function registerDevice(base: string, deviceId?: string): Promise<Registered> {
  const res = await fetch(`${base}/sync/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(deviceId ? { deviceId } : {})
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { deviceCode: string; deviceSecret: string }
  expect(body.deviceCode).toMatch(CODE_RE)
  expect(body.deviceSecret).toMatch(SECRET_RE)
  return { code: body.deviceCode, secret: body.deviceSecret }
}

function authHeaders(reg: Registered): Record<string, string> {
  return { 'x-sync-device-code': reg.code, 'x-sync-device-secret': reg.secret }
}

async function pairState(base: string, reg: Registered): Promise<any> {
  const res = await fetch(`${base}/sync/state`, { headers: authHeaders(reg) })
  expect(res.status).toBe(200)
  return await res.json()
}

async function requestPair(base: string, reg: Registered, targetCode: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/sync/pair/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(reg) },
    body: JSON.stringify({ targetCode })
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function acceptPair(base: string, reg: Registered, requestId: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/sync/pair/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(reg) },
    body: JSON.stringify({ requestId })
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

function topicOp(id: string, entityId: string, deviceId: string, timestamp: number): Record<string, unknown> {
  return {
    id,
    entityType: 'topic',
    op: 'upsert',
    entityId,
    timestamp,
    deviceId,
    payload: { id: entityId, name: `t-${entityId}` }
  }
}

async function pushOps(
  base: string,
  reg: Registered,
  deviceId: string,
  ops: Record<string, unknown>[]
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(reg) },
    body: JSON.stringify({ deviceId, operations: ops })
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function pullOps(
  base: string,
  reg: Registered,
  deviceId: string,
  cursor: number
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/sync/pull?cursor=${cursor}&deviceId=${encodeURIComponent(deviceId)}`, {
    headers: authHeaders(reg)
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('registration and credential fail-closed semantics', () => {
  it('first Connect registers (code + secret); reattach verifies without rotation', async () => {
    const { base, db, close } = await listenRelay()
    try {
      const reg = await registerDevice(base, 'local-uuid-1')
      // Re-attach with the same credential: same code, no new secret.
      const again = await fetch(`${base}/sync/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: reg.code, deviceSecret: reg.secret })
      })
      expect(again.status).toBe(200)
      const againBody = (await again.json()) as { deviceCode: string; deviceSecret?: unknown }
      expect(againBody.deviceCode).toBe(reg.code)
      expect(againBody.deviceSecret).toBeUndefined()
      const count = (db.prepare('SELECT COUNT(*) as n FROM sync_devices').get() as { n: number }).n
      expect(count).toBe(1)
    } finally {
      await close()
      db.close()
    }
  })

  it('unknown credentials fail closed and are never silently re-registered', async () => {
    const { base, db, close } = await listenRelay()
    try {
      const reg = await registerDevice(base)
      const unknown = await fetch(`${base}/sync/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'ZZZZ9999', deviceSecret: '0'.repeat(64) })
      })
      expect(unknown.status).toBe(403)
      expect(((await unknown.json()) as { error: string }).error).toMatch(/unknown-credential/)
      const wrong = await fetch(`${base}/sync/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: reg.code, deviceSecret: '0'.repeat(64) })
      })
      expect(wrong.status).toBe(403)
      expect(((await wrong.json()) as { error: string }).error).toMatch(/invalid-credential/)
      const partial = await fetch(`${base}/sync/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: reg.code })
      })
      expect(partial.status).toBe(403)
      const count = (db.prepare('SELECT COUNT(*) as n FROM sync_devices').get() as { n: number }).n
      expect(count).toBe(1)
    } finally {
      await close()
      db.close()
    }
  })

  it('the public code alone authorizes nothing', async () => {
    const { base, close } = await listenRelay()
    try {
      const reg = await registerDevice(base)
      // State without the secret is refused even though the code is valid.
      const res = await fetch(`${base}/sync/state`, {
        headers: { 'x-sync-device-code': reg.code }
      })
      expect(res.status).toBe(403)
      // Push with a well-formed but wrong secret is refused.
      const push = await pushOps(base, { code: reg.code, secret: 'f'.repeat(64) }, 'uuid-1', [])
      expect(push.status).toBe(403)
      expect(String(push.body.error)).toMatch(/invalid-credential|unknown-credential/)
    } finally {
      await close()
    }
  })
})

describe('pair-request lifecycle', () => {
  it('request is idempotent for the same target and replaced for a new target', async () => {
    const { base, db, close } = await listenRelay()
    try {
      const a = await registerDevice(base)
      const b = await registerDevice(base)
      const c = await registerDevice(base)
      const first = await requestPair(base, b, a.code)
      expect(first.status).toBe(200)
      expect(typeof first.body.requestId).toBe('string')
      const retry = await requestPair(base, b, a.code)
      expect(retry.status).toBe(200)
      expect(retry.body.requestId).toBe(first.body.requestId)
      // New target replaces the old pending request (no expiry involved).
      const replaced = await requestPair(base, b, c.code)
      expect(replaced.status).toBe(200)
      expect(replaced.body.requestId).not.toBe(first.body.requestId)
      const oldRow = db.prepare('SELECT status FROM sync_pair_requests WHERE id = ?').get(first.body.requestId) as {
        status: string
      }
      expect(oldRow.status).toBe('replaced')
      // The replaced request can no longer be accepted.
      const late = await acceptPair(base, a, first.body.requestId)
      expect(late.status).toBe(410)
    } finally {
      await close()
      db.close()
    }
  })

  it('requester cancel and target reject resolve pending without pairing', async () => {
    const { base, close } = await listenRelay()
    try {
      const a = await registerDevice(base)
      const b = await registerDevice(base)
      const req = await requestPair(base, b, a.code)
      expect(req.status).toBe(200)
      const cancel = await fetch(`${base}/sync/pair/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(b) },
        body: JSON.stringify({ requestId: req.body.requestId })
      })
      expect(cancel.status).toBe(200)
      const stateB = await pairState(base, b)
      expect(stateB.outgoing).toBeNull()
      // A fresh request can be rejected by the target.
      const req2 = await requestPair(base, b, a.code)
      const reject = await fetch(`${base}/sync/pair/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(a) },
        body: JSON.stringify({ requestId: req2.body.requestId })
      })
      expect(reject.status).toBe(200)
      const stateA = await pairState(base, a)
      expect(stateA.paired).toBe(false)
      expect(stateA.incoming).toEqual([])
      const stateB2 = await pairState(base, b)
      expect(stateB2.paired).toBe(false)
    } finally {
      await close()
    }
  })

  it('unknown target, self-pairing, and malformed codes fail closed', async () => {
    const { base, close } = await listenRelay()
    try {
      const a = await registerDevice(base)
      expect((await requestPair(base, a, 'ZZZZ9999')).status).toBe(404)
      const self = await requestPair(base, a, a.code)
      expect(self.status).toBe(400)
      const bad = await fetch(`${base}/sync/pair/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(a) },
        body: JSON.stringify({ targetCode: 'short' })
      })
      expect(bad.status).toBe(400)
    } finally {
      await close()
    }
  })
})

describe('atomic channel formation and join rules', () => {
  it('two unpaired devices form a hidden channel on accept', async () => {
    const { base, close } = await listenRelay()
    try {
      const a = await registerDevice(base, 'cli-a')
      const b = await registerDevice(base, 'cli-b')
      const req = await requestPair(base, b, a.code)
      const accepted = await acceptPair(base, a, req.body.requestId)
      expect(accepted.status).toBe(200)
      expect(typeof accepted.body.channelId).toBe('string')
      const stateA = await pairState(base, a)
      const stateB = await pairState(base, b)
      expect(stateA.paired).toBe(true)
      expect(stateB.paired).toBe(true)
      expect(stateA.channelId).toBe(stateB.channelId)
    } finally {
      await close()
    }
  })

  it('unpaired requester joins the paired target channel; paired requester cannot initiate', async () => {
    const { base, close } = await listenRelay()
    try {
      const a = await registerDevice(base, 'cli-a')
      const b = await registerDevice(base, 'cli-b')
      const c = await registerDevice(base, 'cli-c')
      const reqAB = await requestPair(base, b, a.code)
      const acceptedAB = await acceptPair(base, a, reqAB.body.requestId)
      expect(acceptedAB.status).toBe(200)
      // C (unpaired) requests paired A and joins the same hidden channel.
      const reqCA = await requestPair(base, c, a.code)
      expect(reqCA.status).toBe(200)
      const acceptedCA = await acceptPair(base, a, reqCA.body.requestId)
      expect(acceptedCA.status).toBe(200)
      expect(acceptedCA.body.channelId).toBe(acceptedAB.body.channelId)
      // A (paired) cannot initiate another pairing.
      const d = await registerDevice(base, 'cli-d')
      const bad = await requestPair(base, a, d.code)
      expect(bad.status).toBe(409)
      expect(String(bad.body.error)).toMatch(/pairing-already-paired/)
    } finally {
      await close()
    }
  })

  it('late accept after the requester became paired fails with no merge', async () => {
    const { base, db, close } = await listenRelay()
    try {
      const a = await registerDevice(base)
      const b = await registerDevice(base)
      const c = await registerDevice(base)
      // B requests A (pending). Then B pairs with C first.
      const reqBA = await requestPair(base, b, a.code)
      const reqBC = await requestPair(base, b, c.code)
      // B's new-target request replaced the A-bound one; rebuild the case:
      // cancel B->C, re-request B->A, then pair B with C via C->B accept.
      await fetch(`${base}/sync/pair/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(b) },
        body: JSON.stringify({})
      })
      const reqBA2 = await requestPair(base, b, a.code)
      expect(reqBA2.status).toBe(200)
      expect(reqBA.body.requestId).not.toBe(reqBC.body.requestId)
      const reqCB = await requestPair(base, c, b.code)
      // B accepts C's request? B is the target of C->B: B accepts, pairing B+C.
      const acceptedCB = await acceptPair(base, b, reqCB.body.requestId)
      expect(acceptedCB.status).toBe(200)
      // Late accept of B->A by A must fail: B is already paired, no merge.
      // B's stale outgoing was terminated atomically when B paired (same
      // accept transaction), so the late accept observes the terminal
      // replaced state instead of racing the paired requester.
      const late = await acceptPair(base, a, reqBA2.body.requestId)
      expect(late.status).toBe(410)
      expect(String(late.body.error)).toMatch(/request-replaced/)
      const stateB = await pairState(base, b)
      const stateC = await pairState(base, c)
      expect(stateB.paired).toBe(true)
      expect(stateB.channelId).toBe(stateC.channelId)
      const stateA = await pairState(base, a)
      expect(stateA.paired).toBe(false)
      // No partial membership for A leaked.
      const members = (
        db.prepare('SELECT COUNT(*) as n FROM sync_memberships WHERE device_code = ?').get(a.code) as { n: number }
      ).n
      expect(members).toBe(0)
    } finally {
      await close()
      db.close()
    }
  })
})

describe('unpair and dissolve', () => {
  it('unpair removes only self; sub-two membership dissolves and the survivor observes unpaired', async () => {
    const { base, db, close } = await listenRelay()
    try {
      const a = await registerDevice(base, 'cli-a')
      const b = await registerDevice(base, 'cli-b')
      const req = await requestPair(base, b, a.code)
      await acceptPair(base, a, req.body.requestId)
      const unpair = await fetch(`${base}/sync/pair/unpair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(a) },
        body: JSON.stringify({})
      })
      expect(unpair.status).toBe(200)
      // Survivor B observes unpaired on next relay contact.
      const stateB = await pairState(base, b)
      expect(stateB.paired).toBe(false)
      expect(stateB.channelId).toBeNull()
      const stateA = await pairState(base, a)
      expect(stateA.paired).toBe(false)
      // Registration survives unpair: B can immediately request again.
      const c = await registerDevice(base, 'cli-c')
      const req2 = await requestPair(base, b, c.code)
      expect(req2.status).toBe(200)
      // Dissolved channel row remains as a zombie but never blocks.
      const zombies = (db.prepare('SELECT COUNT(*) as n FROM sync_channels WHERE dissolved = 1').get() as { n: number })
        .n
      expect(zombies).toBe(1)
      // Unpair while unpaired is refused.
      const again = await fetch(`${base}/sync/pair/unpair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(a) },
        body: JSON.stringify({})
      })
      expect(again.status).toBe(409)
    } finally {
      await close()
      db.close()
    }
  })
})

describe('production lifecycle: SSE binding, stale-intent cleanup, identity binding', () => {
  /**
   * Read one SSE frame, skipping heartbeat/comment-only frames (`: ...`)
   * which carry no hint. Returns the first data frame, or null on timeout
   * (proves no hint arrived in the window).
   */
  async function readSseFrame(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    state: { buffer: string },
    timeoutMs: number
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      // Race the blocking read against the window so a silent stream proves
      // the negative within the window instead of hanging on the next frame.
      const raced = await Promise.race([
        reader.read().then((r) => ({ kind: 'data' as const, r })),
        new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), remaining))
      ])
      if (raced.kind === 'timeout') return null
      if (raced.r.done) return null
      const value = raced.r.value
      if (value) state.buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const idx = state.buffer.indexOf('\n\n')
        if (idx === -1) break
        const out = state.buffer.slice(0, idx)
        state.buffer = state.buffer.slice(idx + 2)
        // Skip heartbeat/comment-only frames; keep waiting for a data frame.
        if (!out.includes('data:') && out.trimStart().startsWith(':')) continue
        if (out.trim() === '') continue
        return out
      }
    }
    return null
  }

  async function openSubscribe(
    base: string,
    reg: Registered
  ): Promise<{
    reader: ReadableStreamDefaultReader<Uint8Array>
    controller: AbortController
    state: { buffer: string }
  }> {
    const controller = new AbortController()
    const res = await fetch(`${base}/sync/subscribe?cursor=0`, {
      headers: { Accept: 'text/event-stream', ...authHeaders(reg) },
      signal: controller.signal
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    return { reader, controller, state: { buffer: '' } }
  }

  /** Drain the initial `: connected` comment frame (not a data hint). */
  async function drainConnected(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    state: { buffer: string },
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (state.buffer.includes(': connected')) return true
      const remaining = deadline - Date.now()
      const raced = await Promise.race([
        reader.read().then((r) => ({ kind: 'data' as const, r })),
        new Promise<{ kind: 'timeout' }>((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), remaining))
      ])
      if (raced.kind === 'timeout') return state.buffer.includes(': connected')
      if (raced.r.done) return false
      if (raced.r.value) state.buffer += decoder.decode(raced.r.value, { stream: true })
    }
    return state.buffer.includes(': connected')
  }

  it('old-channel hints stop after unpair; other channels keep their streams', async () => {
    const { base, close } = await listenRelay()
    const controllers: AbortController[] = []
    try {
      const a = await registerDevice(base, 'sse-a')
      const b = await registerDevice(base, 'sse-b')
      const c = await registerDevice(base, 'sse-c')
      const d = await registerDevice(base, 'sse-d')
      const reqAB = await requestPair(base, b, a.code)
      await acceptPair(base, a, reqAB.body.requestId)
      const reqCD = await requestPair(base, d, c.code)
      await acceptPair(base, c, reqCD.body.requestId)

      const subB = await openSubscribe(base, b)
      const subProbe = await openSubscribe(base, d)
      controllers.push(subB.controller, subProbe.controller)
      const decoder = new TextDecoder()
      // Drain the initial connected frames on both streams.
      expect(await drainConnected(subB.reader, decoder, subB.state, 5000)).toBe(true)
      expect(await drainConnected(subProbe.reader, decoder, subProbe.state, 5000)).toBe(true)

      // Push on channel AB: only B's stream observes the hint (isolation).
      const pushed = await pushOps(base, a, 'sse-a', [topicOp('sse-op-1', 'sse-t-1', 'sse-a', 1000)])
      expect(pushed.status).toBe(200)
      const hintB = await readSseFrame(subB.reader, decoder, subB.state, 5000)
      expect(hintB).not.toBeNull()
      expect(hintB!).toContain('event: sync')
      expect(hintB!).toContain('"cursor"')
      expect(hintB!).not.toContain('sse-op-1')
      // The other channel's stream observes nothing for this push. The
      // timeout race orphans a pending read on the probe stream, so the probe
      // is discarded afterwards and a fresh stream proves liveness below.
      const hintProbe = await readSseFrame(subProbe.reader, decoder, subProbe.state, 1000)
      expect(hintProbe).toBeNull()
      try {
        subProbe.controller.abort()
      } catch {}
      try {
        await subProbe.reader.cancel().catch(() => {})
      } catch {}

      // A unpairs: channel AB dissolves, so B's departed stream must close.
      const unpair = await fetch(`${base}/sync/pair/unpair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(a) },
        body: JSON.stringify({})
      })
      expect(unpair.status).toBe(200)
      // B's stale stream ends (done) instead of lingering on the old channel.
      const closed = await Promise.race([
        (async (): Promise<boolean> => {
          for (;;) {
            const { done, value } = await subB.reader.read()
            if (done) return true
            if (value) subB.state.buffer += decoder.decode(value, { stream: true })
          }
        })(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000))
      ])
      expect(closed).toBe(true)
      // A fresh stream on the surviving channel still notifies for its own
      // channel: D resubscribes and observes the next CD push.
      const subD = await openSubscribe(base, d)
      controllers.push(subD.controller)
      expect(await drainConnected(subD.reader, decoder, subD.state, 5000)).toBe(true)
      const pushedCD = await pushOps(base, c, 'sse-c', [topicOp('sse-op-2', 'sse-t-2', 'sse-c', 1001)])
      expect(pushedCD.status).toBe(200)
      const hintD2 = await readSseFrame(subD.reader, decoder, subD.state, 5000)
      expect(hintD2).not.toBeNull()
      expect(hintD2!).toContain('event: sync')
      // The departed device cannot resubscribe until it pairs again.
      const resub = await fetch(`${base}/sync/subscribe?cursor=0`, { headers: authHeaders(a) })
      expect(resub.status).toBe(403)
      await resub.text().catch(() => '')
    } finally {
      for (const ctl of controllers) {
        try {
          ctl.abort()
        } catch {}
      }
      await close()
    }
  })

  it('accept terminates other pending outgoing in the same transaction; unpair never revives them', async () => {
    const { base, db, close } = await listenRelay()
    try {
      const a = await registerDevice(base, 'stl-a')
      const b = await registerDevice(base, 'stl-b')
      const c = await registerDevice(base, 'stl-c')
      // B requests A (pending). C requests B (pending). B accepts C->B and
      // pairs with C: B's other pending (B->A) must settle atomically.
      const reqBA = await requestPair(base, b, a.code)
      expect(reqBA.status).toBe(200)
      const reqCB = await requestPair(base, c, b.code)
      expect(reqCB.status).toBe(200)
      const accepted = await acceptPair(base, b, reqCB.body.requestId)
      expect(accepted.status).toBe(200)
      const staleRow = db.prepare('SELECT status FROM sync_pair_requests WHERE id = ?').get(reqBA.body.requestId) as {
        status: string
      }
      expect(staleRow.status).toBe('replaced')
      const stateB = await pairState(base, b)
      expect(stateB.paired).toBe(true)
      // Paired state carries no revivable outgoing (never hidden, never pending).
      expect(stateB.outgoing).toBeNull()
      // Unpair dissolves the channel; the stale intent stays terminal.
      const unpair = await fetch(`${base}/sync/pair/unpair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(b) },
        body: JSON.stringify({})
      })
      expect(unpair.status).toBe(200)
      const stateBAfter = await pairState(base, b)
      expect(stateBAfter.paired).toBe(false)
      expect(stateBAfter.outgoing).toBeNull()
      const late = await acceptPair(base, a, reqBA.body.requestId)
      expect(late.status).toBe(410)
      expect(String(late.body.error)).toMatch(/request-replaced/)
    } finally {
      await close()
      db.close()
    }
  })

  it('push with a forged device id is refused without leaking credentials', async () => {
    const { base, close } = await listenRelay()
    try {
      const a = await registerDevice(base, 'idb-a')
      const b = await registerDevice(base, 'idb-b')
      const req = await requestPair(base, b, a.code)
      await acceptPair(base, a, req.body.requestId)
      // Body/op agree with each other but not with the registration: 403.
      const forged = await pushOps(base, a, 'forged-id', [topicOp('idb-op-1', 'idb-t-1', 'forged-id', 1000)])
      expect(forged.status).toBe(403)
      expect(String(forged.body.error)).toMatch(/device identity mismatch/)
      expect(JSON.stringify(forged.body)).not.toContain(a.code)
      expect(JSON.stringify(forged.body)).not.toContain(a.secret)
      // Operation disagreeing with the body is still a 400 before binding.
      const mismatch = await pushOps(base, a, 'idb-a', [topicOp('idb-op-2', 'idb-t-2', 'someone-else', 1001)])
      expect(mismatch.status).toBe(400)
      // The real registered client id still pushes cleanly.
      const ok = await pushOps(base, a, 'idb-a', [topicOp('idb-op-3', 'idb-t-3', 'idb-a', 1002)])
      expect(ok.status).toBe(200)
      expect(ok.body.acceptedIds).toEqual(['idb-op-3'])
    } finally {
      await close()
    }
  })
})
describe('paired-membership data plane and per-channel sequencing', () => {
  it('unpaired devices are refused sync with pairing-required', async () => {
    const { base, close } = await listenRelay()
    try {
      const a = await registerDevice(base)
      const push = await pushOps(base, a, 'uuid-a', [topicOp('op-1', 't-1', 'uuid-a', 1000)])
      expect(push.status).toBe(403)
      expect(String(push.body.error)).toMatch(/pairing-required/)
      const pull = await pullOps(base, a, 'uuid-a', 0)
      expect(pull.status).toBe(403)
      const sub = await fetch(`${base}/sync/subscribe?cursor=0`, { headers: authHeaders(a) })
      expect(sub.status).toBe(403)
      // Unknown credentials fail closed before the pairing check.
      const ghost = await pushOps(base, { code: 'ZZZZ9999', secret: '0'.repeat(64) }, 'uuid-x', [])
      expect(ghost.status).toBe(403)
      expect(String(ghost.body.error)).toMatch(/unknown-credential/)
    } finally {
      await close()
    }
  })

  it('two independent channels are isolated with independent contiguous cursors', async () => {
    const { base, close } = await listenRelay()
    try {
      const a = await registerDevice(base, 'cli-a')
      const b = await registerDevice(base, 'cli-b')
      const c = await registerDevice(base, 'cli-c')
      const d = await registerDevice(base, 'cli-d')
      const reqAB = await requestPair(base, b, a.code)
      await acceptPair(base, a, reqAB.body.requestId)
      const reqCD = await requestPair(base, d, c.code)
      await acceptPair(base, c, reqCD.body.requestId)
      // Push distinct traffic per channel (real registered client ids).
      const pushAB = await pushOps(base, a, 'cli-a', [
        topicOp('op-ab-1', 't-ab-1', 'cli-a', 1000),
        topicOp('op-ab-2', 't-ab-2', 'cli-a', 1001)
      ])
      expect(pushAB.status).toBe(200)
      expect(pushAB.body.cursor).toBe(2)
      const pushCD = await pushOps(base, c, 'cli-c', [topicOp('op-cd-1', 't-cd-1', 'cli-c', 1000)])
      expect(pushCD.status).toBe(200)
      expect(pushCD.body.cursor).toBe(1)
      // Each channel observes only its own contiguous sequence from its origin.
      const pullB = await pullOps(base, b, 'cli-b', 0)
      expect(pullB.status).toBe(200)
      expect(pullB.body.operations.map((o: any) => o.id)).toEqual(['op-ab-1', 'op-ab-2'])
      expect(pullB.body.operations.map((o: any) => o.seq)).toEqual([1, 2])
      expect(pullB.body.cursor).toBe(2)
      const pullD = await pullOps(base, d, 'cli-d', 0)
      expect(pullD.status).toBe(200)
      expect(pullD.body.operations.map((o: any) => o.id)).toEqual(['op-cd-1'])
      expect(pullD.body.cursor).toBe(1)
      // Cross-channel cursor reuse is rejected as non-contiguous framing
      // would be: channel CD has no seq 2 yet, so cursor 2 yields empty.
      const pullCross = await pullOps(base, d, 'cli-d', 2)
      expect(pullCross.status).toBe(200)
      expect(pullCross.body.operations).toEqual([])
      // Identical replay is idempotent without cursor growth.
      const replay = await pushOps(base, a, 'cli-a', [topicOp('op-ab-1', 't-ab-1', 'cli-a', 1000)])
      expect(replay.status).toBe(200)
      expect(replay.body.acceptedIds).toEqual(['op-ab-1'])
      expect(replay.body.cursor).toBe(2)
      // Illegal operations never land on the channel.
      const bad = await pushOps(base, a, 'cli-a', [
        { ...topicOp('op-bad', 't-bad', 'cli-a', 1002), entityType: 'nonsense' }
      ])
      expect(bad.status).toBe(400)
      const after = await pullOps(base, b, 'cli-b', 2)
      expect(after.body.operations).toEqual([])
    } finally {
      await close()
    }
  })
})

describe('shared SYNC-CC core conformance (production SQLite :memory: observable contract)', () => {
  it('memory and production share the observable cases/error vocabulary', async () => {
    const token = 'cc-conformance-token'
    const { base, db, close } = await listenRelay(token)
    try {
      // Implementation-level SSE rebind evidence for the production relay:
      // the shared core runs directly against createRelayServer, so channel
      // isolation and departed-stream close are proven here without a
      // fragile E2E stream read. SQLite atomicity/concurrency stays in the
      // exclusive tests above; this case locks only the shared vocabulary.
      await runRelayConformanceCore({ endpoint: base, token })
    } finally {
      await close()
      db.close()
    }
  })
})
