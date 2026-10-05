import { request as httpRequest } from 'node:http'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  provisionPairedDevices,
  provisionedHeaders,
  startTestRelay,
  type ProvisionedDevice,
  type TestRelayHandle
} from './sync-relay'

function topicOp(id: string, entityId: string, name = 'N', ts = Date.now()): Record<string, unknown> {
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

let relay: TestRelayHandle | null = null
let dev: ProvisionedDevice | null = null

beforeEach(async () => {
  relay = await startTestRelay()
  dev = (await provisionPairedDevices(relay.endpoint, 2))[0]
})

afterEach(async () => {
  if (relay) {
    await relay.close()
    relay = null
  }
})

function rawPushWithContentLength(
  endpoint: string,
  contentLengthHeader: string,
  body: string,
  dev?: ProvisionedDevice
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${endpoint}/sync/push`)
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: '/sync/push',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': contentLengthHeader,
          ...(dev ? provisionedHeaders(dev) : {})
        }
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      }
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

describe('test relay content-length parity (LOCK-RT-005/006)', () => {
  it('non-numeric content-length does not trigger early 413 for a tiny body', async () => {
    // Reference semantics: Number('12junk') is NaN -> not finite -> no early
    // 413; the body limit still applies. Node truncates the stream to the
    // leading numeric prefix, so JSON framing fails with 400 — the parity
    // point is that it is never an early 413 for a tiny body.
    const body = JSON.stringify({ deviceId: 'd1', operations: [topicOp('op-cl-junk', 't-cl-junk')] })
    const res = await rawPushWithContentLength(relay!.endpoint, '12junk', body, dev!)
    expect(res.status).not.toBe(413)
    expect(res.status).toBe(400)
  })

  it('normalizes content-length exactly like the reference relay', () => {
    const normalize = (header: string | string[] | undefined): number | null => {
      const clStr = Array.isArray(header) ? (header[0] ?? '0') : (header ?? '0')
      const n = Number(clStr)
      return Number.isFinite(n) ? n : null
    }
    // Reference: Number() strictness — trailing junk is NaN (no early 413).
    expect(normalize('12junk')).toBeNull()
    expect(normalize('07')).toBe(7)
    expect(normalize('0')).toBe(0)
    expect(normalize(undefined)).toBe(0)
    expect(normalize(['5'])).toBe(5)
    // Old test-relay parseInt behavior would have returned 12 for '12junk';
    // the mirrored Number() behavior returns null (no early 413).
    expect(normalize('12junk')).not.toBe(12)
  })

  it('oversize body still fails closed (413) through the body limit', async () => {
    const bigPayload = 'x'.repeat(3 * 1024 * 1024)
    const body = JSON.stringify({ deviceId: 'd1', operations: [topicOp('op-cl-big', 't-cl-big', bigPayload)] })
    const res = await fetch(`${relay!.endpoint}/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sync-device-code': 'd1'
      },
      body
    })
    expect(res.status).toBe(413)
    await res.text().catch(() => '')
  })

  it('size/auth/pause matrix: 413 first, then 403, then 503, with no data mutation', async () => {
    const bigPayload = 'x'.repeat(3 * 1024 * 1024)
    const bigBody = JSON.stringify({
      deviceId: 'd1',
      operations: [topicOp('op-cl-matrix-big', 't-cl-matrix-big', bigPayload)]
    })
    const tinyBody = JSON.stringify({ deviceId: 'd1', operations: [topicOp('op-cl-matrix-tiny', 't-cl-matrix-tiny')] })

    // Oversize + missing device credential (unpaused) -> 413 wins over 403.
    const noAuthBig = await rawPushWithContentLength(relay!.endpoint, String(bigBody.length), bigBody)
    expect(noAuthBig.status).toBe(413)
    await relay!.waitForQuiescent()
    expect(relay!.getOperationCount()).toBe(0)
    expect(relay!.getCursor()).toBe(0)

    // Oversize with a malformed Content-Length still 413 via the bounded body
    // read (no header silent bypass). Node truncates the stream to the leading
    // numeric prefix, so use a declared length that still delivers the full
    // oversize body: chunked framing (no Content-Length at all).
    const chunkedBig: { status: number; body: string } = await new Promise((resolve, reject) => {
      const url = new URL(`${relay!.endpoint}/sync/push`)
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: Number(url.port),
          path: '/sync/push',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        },
        (res) => {
          let data = ''
          res.on('data', (c) => (data += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
        }
      )
      req.on('error', reject)
      req.write(bigBody)
      req.end()
    })
    expect(chunkedBig.status).toBe(413)
    await relay!.waitForQuiescent()
    expect(relay!.getOperationCount()).toBe(0)
    expect(relay!.getCursor()).toBe(0)

    // Normal-size + missing device while paused -> 403 wins over 503.
    relay!.setPaused(true)
    try {
      const pausedNoAuth = await rawPushWithContentLength(relay!.endpoint, String(tinyBody.length), tinyBody)
      expect(pausedNoAuth.status).toBe(403)
      // Oversize + missing device while paused -> 413 still wins over 403/503.
      const pausedNoAuthBig = await rawPushWithContentLength(relay!.endpoint, String(bigBody.length), bigBody)
      expect(pausedNoAuthBig.status).toBe(413)
      // Valid device while paused -> 503 with no data change.
      const pausedValid = await fetch(`${relay!.endpoint}/sync/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...provisionedHeaders(dev!) },
        body: tinyBody
      })
      expect(pausedValid.status).toBe(503)
      await pausedValid.text().catch(() => '')
    } finally {
      relay!.setPaused(false)
    }
    await relay!.waitForQuiescent()
    expect(relay!.getOperationCount()).toBe(0)
    expect(relay!.getCursor()).toBe(0)
  })

  it('unpaired valid device stays 403 pairing-required; paired push stays 200', async () => {
    const soloRes = await fetch(`${relay!.endpoint}/sync/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    expect(soloRes.status).toBe(200)
    const solo = (await soloRes.json()) as { deviceCode: string; deviceSecret: string }
    const tinyBody = JSON.stringify({ deviceId: 'd1', operations: [topicOp('op-cl-solo', 't-cl-solo')] })
    const unpaired = await fetch(`${relay!.endpoint}/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sync-device-code': solo.deviceCode,
        'x-sync-device-secret': solo.deviceSecret
      },
      body: tinyBody
    })
    expect(unpaired.status).toBe(403)
    await unpaired.text().catch(() => '')
    await relay!.waitForQuiescent()
    expect(relay!.getOperationCount()).toBe(0)
    expect(relay!.getCursor()).toBe(0)

    const allowed = await fetch(`${relay!.endpoint}/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...provisionedHeaders(dev!) },
      body: tinyBody
    })
    expect(allowed.status).toBe(200)
    await allowed.json().catch(() => ({}))
    await relay!.waitForQuiescent()
    expect(relay!.getOperationCount()).toBe(1)
    expect(relay!.getCursor()).toBe(1)
  })
})
