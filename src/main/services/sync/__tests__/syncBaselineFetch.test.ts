/**
 * SyncClient.fetchBaseline (SYNC-CC-023): GET /sync/baseline strict fetch.
 * 200 strictly parses via shared parseEnvelopeJson (exact keys/duplicate-key
 * rejection); 404 is an explicit no-baseline typed result; other non-2xx
 * retain relay {error} via the existing safe mapping; abort/timeout patterns
 * mirror push/pull.
 */
import { createHash } from 'node:crypto'

import {
  COMPLETENESS_COMPLETE,
  computeSyncDigest,
  DIGEST_SCHEME,
  INVENTORY_VERSION,
  ORDER_FRAME_VERSION,
  PAYLOAD_SCHEMA,
  SCOPE,
  WIRE_VERSION
} from '@shared/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { syncClient } from '../SyncClient'

const ENDPOINT = 'http://127.0.0.1:9'
const CODE = 'ABCD2345'
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'

function hashHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function emptyPayload(): Record<string, unknown> {
  return {
    payloadSchema: PAYLOAD_SCHEMA,
    inventoryVersion: INVENTORY_VERSION,
    orderFrameVersion: ORDER_FRAME_VERSION,
    scope: SCOPE,
    topics: [],
    messages: [],
    messageBlocks: [],
    tombstones: [],
    orderFrames: [],
    manifest: {
      payloadSchema: PAYLOAD_SCHEMA,
      inventoryVersion: INVENTORY_VERSION,
      orderFrameVersion: ORDER_FRAME_VERSION,
      scope: SCOPE,
      liveCounts: { topic: 0, message: 0, messageBlock: 0 },
      tombstoneCounts: { topic: 0, message: 0, messageBlock: 0 },
      frameCounts: { topicMessage: 0, messageBlock: 0 },
      completeness: COMPLETENESS_COMPLETE
    }
  }
}

function makeEnvelope(channelId: string, watermark: number, payload: Record<string, unknown>): Record<string, unknown> {
  const digest = computeSyncDigest(payload as never, hashHex)
  return { wireVersion: WIRE_VERSION, channelId, watermark, digestScheme: DIGEST_SCHEME, digest, payload }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SyncClient.fetchBaseline', () => {
  it('200 returns strictly parsed envelope with device headers', async () => {
    const envelope = makeEnvelope('ch-1', 5, emptyPayload())
    const raw = JSON.stringify(envelope)
    let seenUrl = ''
    let seenHeaders: Record<string, string> = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { headers?: Record<string, string> }) => {
        seenUrl = url
        seenHeaders = init.headers ?? {}
        return { ok: true, status: 200, text: async () => raw } as never
      })
    )
    const res = await syncClient.fetchBaseline(ENDPOINT, 'tok', CODE, SECRET)
    expect(res.found).toBe(true)
    if (res.found) {
      expect(res.envelope.channelId).toBe('ch-1')
      expect(res.envelope.watermark).toBe(5)
      expect(res.rawText).toBe(raw)
    }
    expect(seenUrl).toBe(`${ENDPOINT}/sync/baseline`)
    expect(seenHeaders['x-sync-device-code']).toBe(CODE)
    expect(seenHeaders['Authorization']).toBe('Bearer tok')
  })

  it('404 with strict baseline-not-found body is explicit no-baseline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, text: async () => '{"error":"baseline-not-found"}' }) as never)
    )
    const res = await syncClient.fetchBaseline(ENDPOINT, undefined, CODE, SECRET)
    expect(res).toEqual({ found: false })
  })

  it.each([
    ['html body', '<html>not found</html>'],
    ['empty body', ''],
    ['other error', '{"error":"channel-mismatch"}'],
    ['extra keys', '{"error":"baseline-not-found","extra":1}'],
    ['non-object', '[]']
  ])('404 with %s throws via relay mapping (never false no-baseline)', async (_label, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, text: async () => body }) as never)
    )
    await expect(syncClient.fetchBaseline(ENDPOINT, undefined, CODE, SECRET)).rejects.toThrow(
      /baseline fetch failed 404/
    )
  })

  it('other errors retain relay {error} via safe mapping', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, text: async () => '{"error":"pairing-required"}' }) as never)
    )
    await expect(syncClient.fetchBaseline(ENDPOINT, undefined, CODE, SECRET)).rejects.toThrow(
      /baseline fetch failed 403.*pairing-required/
    )
  })

  it('duplicate complete outer key-value pair fails closed via strict duplicate rejection', async () => {
    const envelope = makeEnvelope('ch-1', 0, emptyPayload())
    const raw = JSON.stringify(envelope)
    expect(raw).toContain('"channelId":"ch-1"')
    const dup = raw.replace('"channelId":"ch-1"', '"channelId":"ch-1","channelId":"ch-1"')
    expect(dup).not.toBe(raw)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => dup }) as never)
    )
    await expect(syncClient.fetchBaseline(ENDPOINT, undefined, CODE, SECRET)).rejects.toThrow(
      /baseline fetch response malformed.*duplicate key "channelId"/
    )
  })

  it('unknown keys fail closed (exact-keys strict)', async () => {
    const envelope = makeEnvelope('ch-1', 0, emptyPayload())
    envelope['extra'] = 1
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(envelope) }) as never)
    )
    await expect(syncClient.fetchBaseline(ENDPOINT, undefined, CODE, SECRET)).rejects.toThrow(
      /baseline fetch response malformed/
    )
  })

  it('external abort propagates AbortError', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(syncClient.fetchBaseline(ENDPOINT, undefined, CODE, SECRET, controller.signal)).rejects.toThrow()
  })
})
