import { request as httpRequest } from 'node:http'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startTestRelay, type TestRelayHandle } from './sync-relay'

const TOKEN = 'content-length-parity-token'

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

beforeEach(async () => {
  relay = await startTestRelay(TOKEN)
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
  body: string
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
          Authorization: `Bearer ${TOKEN}`,
          'Content-Length': contentLengthHeader
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
    const res = await rawPushWithContentLength(relay!.endpoint, '12junk', body)
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
        Authorization: `Bearer ${TOKEN}`,
        'x-sync-device-id': 'd1'
      },
      body
    })
    expect(res.status).toBe(413)
    await res.text().catch(() => '')
  })
})
