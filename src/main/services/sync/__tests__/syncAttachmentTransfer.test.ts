/**
 * SyncClient attachment transfer primitives (`uploadAttachment` /
 * `downloadAttachment`) — focused unit with stubbed transport.
 *
 * NOT RUN in this unit (branch writer owns the checkout runtime lane) — report only.
 * Covers: strict digest rejection before transport, receipt parsing + length
 * coherence, safe relay-error mapping (no credential/content echo), timeout vs
 * external-abort behavior, download incremental hash verification failure,
 * declared/expected length mismatch, wrong content-type, and 404 mapping.
 */
import { createHash } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SyncClient } from '../SyncClient'

const ENDPOINT = 'http://127.0.0.1:3030'
const DEVICE_CODE = 'ABCDEFGH'
const DEVICE_SECRET = 'a'.repeat(64)
const TOKEN = 'transfer-test-token'

function shaHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function bytesResponse(status: number, bytes: Uint8Array, extraHeaders?: Record<string, string>): Response {
  return new Response(bytes as unknown as BodyInit, {
    status,
    headers: { 'content-type': 'application/octet-stream', ...extraHeaders }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SyncClient.uploadAttachment', () => {
  it('rejects a non-strict digest before any transport', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = new SyncClient()
    const payload = new TextEncoder().encode('x')
    await expect(
      client.uploadAttachment(
        ENDPOINT,
        TOKEN,
        { digest: shaHex(payload).toUpperCase(), body: Buffer.from(payload) },
        DEVICE_CODE,
        DEVICE_SECRET
      )
    ).rejects.toThrow('invalid digest')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('parses the relay receipt and enforces length coherence', async () => {
    const payload = Buffer.from('upload-bytes-ok')
    const digest = shaHex(payload)
    const fetchMock = vi.fn(async () => jsonResponse(200, { digest, byteLength: payload.length, deduplicated: false }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new SyncClient()
    const receipt = await client.uploadAttachment(
      ENDPOINT,
      TOKEN,
      { digest, byteLength: payload.length, body: payload },
      DEVICE_CODE,
      DEVICE_SECRET
    )
    expect(receipt).toEqual({ digest, byteLength: payload.length, deduplicated: false })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${ENDPOINT}/sync/attachments/${digest}`)
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream')
    await expect(
      client.uploadAttachment(
        ENDPOINT,
        TOKEN,
        { digest, byteLength: payload.length + 1, body: payload },
        DEVICE_CODE,
        DEVICE_SECRET
      )
    ).rejects.toThrow('length mismatch')
  })

  it('maps relay failures safely without echoing credential material', async () => {
    const payload = Buffer.from('upload-bytes-fail')
    const digest = shaHex(payload)
    const fetchMock = vi.fn(async () =>
      jsonResponse(413, { error: 'attachment-too-large', deviceSecret: DEVICE_SECRET })
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = new SyncClient()
    const err = (await client
      .uploadAttachment(ENDPOINT, TOKEN, { digest, body: payload }, DEVICE_CODE, DEVICE_SECRET)
      .catch((e: unknown) => e as Error)) as Error
    expect(err.message).toContain('attachment upload failed 413')
    expect(err.message).not.toContain(DEVICE_SECRET)
  })

  it('maps a wrong-digest relay failure without echoing content', async () => {
    const payload = Buffer.from('other-content')
    const digest = shaHex(Buffer.from('real-content'))
    const fetchMock = vi.fn(async () => jsonResponse(400, { error: 'digest-mismatch' }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new SyncClient()
    await expect(
      client.uploadAttachment(ENDPOINT, TOKEN, { digest, body: payload }, DEVICE_CODE, DEVICE_SECRET)
    ).rejects.toThrow('attachment upload failed 400: {"error":"digest-mismatch"}')
  })

  it('turns transport aborts into timeout errors, external aborts propagate', async () => {
    const payload = Buffer.from('timeout-bytes')
    const digest = shaHex(payload)
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(abortErr))
    )
    const client = new SyncClient()
    await expect(
      client.uploadAttachment(ENDPOINT, TOKEN, { digest, body: payload }, DEVICE_CODE, DEVICE_SECRET)
    ).rejects.toThrow('attachment upload timeout')
    const external = new AbortController()
    external.abort()
    await expect(
      client.uploadAttachment(ENDPOINT, TOKEN, { digest, body: payload }, DEVICE_CODE, DEVICE_SECRET, external.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('SyncClient.downloadAttachment', () => {
  it('streams verified bytes to the sink and returns the length', async () => {
    const payload = Buffer.from('download-bytes-ok')
    const digest = shaHex(payload)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bytesResponse(200, payload))
    )
    const client = new SyncClient()
    const seen: Buffer[] = []
    const out = await client.downloadAttachment(
      ENDPOINT,
      TOKEN,
      { digest, expectedByteLength: payload.length },
      DEVICE_CODE,
      DEVICE_SECRET,
      undefined,
      (chunk) => {
        seen.push(Buffer.from(chunk))
      }
    )
    expect(out).toEqual({ digest, byteLength: payload.length })
    expect(Buffer.concat(seen).equals(payload)).toBe(true)
  })

  it('rejects bytes whose hash differs (safe digest-mismatch, no content echo)', async () => {
    const payload = Buffer.from('tampered-bytes')
    const digest = shaHex(Buffer.from('expected-bytes'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bytesResponse(200, payload))
    )
    const client = new SyncClient()
    const err = (await client
      .downloadAttachment(ENDPOINT, TOKEN, { digest }, DEVICE_CODE, DEVICE_SECRET)
      .catch((e: unknown) => e as Error)) as Error
    expect(err.message).toContain('digest-mismatch')
    expect(err.message).not.toContain(payload.toString('utf8'))
  })

  it('rejects declared/expected length mismatch before streaming', async () => {
    const payload = Buffer.from('download-bytes-len')
    const digest = shaHex(payload)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bytesResponse(200, payload, { 'content-length': String(payload.length) }))
    )
    const client = new SyncClient()
    await expect(
      client.downloadAttachment(
        ENDPOINT,
        TOKEN,
        { digest, expectedByteLength: payload.length + 1 },
        DEVICE_CODE,
        DEVICE_SECRET
      )
    ).rejects.toThrow('length mismatch')
  })

  it('rejects a non-octet-stream body and maps 404 safely', async () => {
    const payload = Buffer.from('download-bytes-ct')
    const digest = shaHex(payload)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(payload as unknown as BodyInit, { status: 200, headers: { 'content-type': 'text/html' } })
      )
    )
    const client = new SyncClient()
    await expect(client.downloadAttachment(ENDPOINT, TOKEN, { digest }, DEVICE_CODE, DEVICE_SECRET)).rejects.toThrow(
      'content type must be application/octet-stream'
    )

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(404, { error: 'attachment-not-found' }))
    )
    const err = (await client
      .downloadAttachment(ENDPOINT, TOKEN, { digest }, DEVICE_CODE, DEVICE_SECRET)
      .catch((e: unknown) => e as Error)) as Error
    expect(err.message).toContain('attachment download failed 404')
    expect(err.message).not.toContain(DEVICE_SECRET)
  })
})
