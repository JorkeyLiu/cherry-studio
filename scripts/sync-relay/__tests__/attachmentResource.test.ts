/**
 * Relay per-channel attachment bytes (`attachmentResource.ts` + `server.ts`
 * registration) — streaming operator-owned file store.
 *
 * Real `createRelayServer` coverage (no mocks for auth/channel): register +
 * pair devices over HTTP, then PUT/GET raw bytes. Covers round-trip,
 * idempotent dedup replay, channel isolation (404, no oracle), strict digest
 * (uppercase/short/empty/traversal → 400), wrong-body 400 with no final file,
 * malformed Content-Length 400, missing asset 404, device 403 precedence,
 * unpaired 403, over-ceiling 413 with no final file, aborted partial with no
 * final file, chunked PUT, dedup restart retention (file-DB blob data kept),
 * `:memory:` owned disposable tmp cleanup on close, and a >32MiB chunked
 * stream (synthetic 64KiB chunks, bounded memory — never one big buffer).
 *
 * NOT RUN in this unit (branch writer owns the checkout runtime lane) — report only.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect as netConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { handleAttachmentRequest } from '../attachmentResource'
import { createRelayServer, ensureRelaySchema } from '../server'

const DEVICE_CODE_HEADER = 'x-sync-device-code'
const DEVICE_SECRET_HEADER = 'x-sync-device-secret'

let dbs: Database.Database[] = []
let servers: Array<{ close: (cb?: () => void) => void }> = []
let tmpDirs: string[] = []

afterEach(async () => {
  for (const s of servers) {
    try {
      await new Promise<void>((resolve) => {
        try {
          s.close(() => resolve())
        } catch {
          resolve()
        }
      })
    } catch {}
  }
  servers = []
  for (const db of dbs) {
    try {
      db.close()
    } catch {}
  }
  dbs = []
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  tmpDirs = []
})

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-attach-stream-'))
  tmpDirs.push(dir)
  return dir
}

interface LiveServer {
  base: string
  db: Database.Database
  server: ReturnType<typeof createRelayServer>
  blobDir: string
}

async function startFileServer(opts?: { maxAttachmentBytes?: number }): Promise<LiveServer> {
  const root = tmpRoot()
  const dbPath = join(root, 'relay.db')
  const db = new Database(dbPath)
  dbs.push(db)
  ensureRelaySchema(db)
  const server = createRelayServer(db, {
    ...(opts?.maxAttachmentBytes !== undefined ? { maxAttachmentBytes: opts.maxAttachmentBytes } : {})
  })
  servers.push(server as unknown as { close: (cb?: () => void) => void })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${addr.port}`,
    db,
    server,
    blobDir: (server as unknown as { __relayBlobDir: string }).__relayBlobDir
  }
}

interface HttpResult {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

function httpCall(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: Buffer,
  opts?: { chunked?: boolean }
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base)
    const sendHeaders: Record<string, string> = { ...headers }
    if (body && !opts?.chunked) sendHeaders['content-length'] = String(body.length)
    const req = httpRequest(url, { method, headers: sendHeaders }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks)
        })
      )
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function rawCallWithContentLength(
  base: string,
  path: string,
  headers: Record<string, string>,
  declaredLength: string,
  body: Buffer
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base)
    const socket = netConnect(url.port ? Number(url.port) : 80, url.hostname, () => {
      let head = `PUT ${path} HTTP/1.1\r\nHost: ${url.hostname}\r\nContent-Length: ${declaredLength}\r\nConnection: close\r\n`
      for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`
      head += '\r\n'
      socket.write(head)
      socket.write(body)
    })
    const chunks: Buffer[] = []
    socket.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    socket.on('close', () => {
      const raw = Buffer.concat(chunks).toString('latin1')
      const statusMatch = /HTTP\/1\.1 (\d{3})/.exec(raw)
      const status = statusMatch ? Number(statusMatch[1]) : 0
      const sep = raw.indexOf('\r\n\r\n')
      resolve({ status, body: Buffer.from(sep >= 0 ? raw.slice(sep + 4) : '') })
    })
    socket.on('error', reject)
  })
}

function shaHex(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function deviceHeaders(code: string, secret: string): Record<string, string> {
  const h: Record<string, string> = {
    [DEVICE_CODE_HEADER]: code,
    [DEVICE_SECRET_HEADER]: secret
  }
  return h
}

async function jsonCall(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown
): Promise<{ status: number; json: unknown }> {
  const text = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  const res = await httpCall(
    base,
    method,
    path,
    { ...headers, ...(text ? { 'content-type': 'application/json' } : {}) },
    text
  )
  let parsed: unknown = null
  try {
    parsed = res.body.length > 0 ? JSON.parse(res.body.toString('utf8')) : null
  } catch {
    parsed = null
  }
  return { status: res.status, json: parsed }
}

async function registerDevice(base: string): Promise<{ deviceCode: string; deviceSecret: string }> {
  const res = await jsonCall(base, 'POST', '/sync/register', {}, {})
  expect(res.status).toBe(200)
  const j = res.json as { deviceCode: string; deviceSecret: string }
  expect(typeof j.deviceCode).toBe('string')
  expect(typeof j.deviceSecret).toBe('string')
  return { deviceCode: j.deviceCode, deviceSecret: j.deviceSecret }
}

async function pairDevices(
  base: string,
  a: { deviceCode: string; deviceSecret: string },
  b: { deviceCode: string; deviceSecret: string }
): Promise<string> {
  const req = await jsonCall(
    base,
    'POST',
    '/sync/pair/request',
    { [DEVICE_CODE_HEADER]: a.deviceCode, [DEVICE_SECRET_HEADER]: a.deviceSecret },
    { targetCode: b.deviceCode }
  )
  expect(req.status).toBe(200)
  const requestId = (req.json as { requestId: string }).requestId
  const accept = await jsonCall(
    base,
    'POST',
    '/sync/pair/accept',
    { [DEVICE_CODE_HEADER]: b.deviceCode, [DEVICE_SECRET_HEADER]: b.deviceSecret },
    { requestId }
  )
  expect(accept.status).toBe(200)
  return (accept.json as { channelId: string }).channelId
}

function channelFinalCount(blobDir: string): number {
  // Count final blob files (temp `.*.part-*` files are never counted as ready).
  let n = 0
  let entries: string[] = []
  try {
    entries = readdirSync(blobDir)
  } catch {
    return 0
  }
  for (const ch of entries) {
    if (!ch.startsWith('ch-')) continue
    let files: string[] = []
    try {
      files = readdirSync(join(blobDir, ch))
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.startsWith('.')) n += 1
    }
  }
  return n
}

describe('attachment streaming relay resource', () => {
  it('PUT/GET round-trips binary bytes with octet-stream headers', async () => {
    const { base } = await startFileServer()
    const a = await registerDevice(base)
    const b = await registerDevice(base)
    await pairDevices(base, a, b)
    const payload = Buffer.from([0, 1, 2, 250, 255, 104, 101, 108, 108, 111])
    const digest = shaHex(payload)
    const put = await httpCall(
      base,
      'PUT',
      `/sync/attachments/${digest}`,
      { ...deviceHeaders(a.deviceCode, a.deviceSecret), 'content-type': 'application/octet-stream' },
      payload
    )
    expect(put.status).toBe(200)
    expect(JSON.parse(put.body.toString('utf8'))).toMatchObject({
      digest,
      byteLength: payload.length,
      deduplicated: false
    })
    const get = await httpCall(base, 'GET', `/sync/attachments/${digest}`, deviceHeaders(a.deviceCode, a.deviceSecret))
    expect(get.status).toBe(200)
    expect(get.headers['content-type']).toBe('application/octet-stream')
    expect(get.headers['content-length']).toBe(String(payload.length))
    expect(get.body.equals(payload)).toBe(true)
    // Cross-device same-channel read works (channel scope, not device scope).
    const getB = await httpCall(base, 'GET', `/sync/attachments/${digest}`, deviceHeaders(b.deviceCode, b.deviceSecret))
    expect(getB.status).toBe(200)
    expect(getB.body.equals(payload)).toBe(true)
  })

  it('chunked PUT without Content-Length streams to the same final', async () => {
    const { base } = await startFileServer()
    const a = await registerDevice(base)
    const b = await registerDevice(base)
    await pairDevices(base, a, b)
    const payload = Buffer.from('chunked-transfer-bytes-ok')
    const digest = shaHex(payload)
    const put = await httpCall(
      base,
      'PUT',
      `/sync/attachments/${digest}`,
      { ...deviceHeaders(a.deviceCode, a.deviceSecret), 'content-type': 'application/octet-stream' },
      payload,
      { chunked: true }
    )
    expect(put.status).toBe(200)
    expect(JSON.parse(put.body.toString('utf8'))).toMatchObject({ digest, byteLength: payload.length })
  })

  it('idempotent replay stores nothing new and keeps original bytes', async () => {
    const { base, blobDir } = await startFileServer()
    const a = await registerDevice(base)
    const b = await registerDevice(base)
    await pairDevices(base, a, b)
    const payload = Buffer.from('same-bytes-idempotent')
    const digest = shaHex(payload)
    const auth = { ...deviceHeaders(a.deviceCode, a.deviceSecret), 'content-type': 'application/octet-stream' }
    const first = await httpCall(base, 'PUT', `/sync/attachments/${digest}`, auth, payload)
    expect(JSON.parse(first.body.toString('utf8'))).toMatchObject({ deduplicated: false })
    expect(channelFinalCount(blobDir)).toBe(1)
    const second = await httpCall(base, 'PUT', `/sync/attachments/${digest}`, auth, payload)
    expect(second.status).toBe(200)
    expect(JSON.parse(second.body.toString('utf8'))).toMatchObject({ digest, deduplicated: true })
    expect(channelFinalCount(blobDir)).toBe(1)
    const get = await httpCall(base, 'GET', `/sync/attachments/${digest}`, deviceHeaders(a.deviceCode, a.deviceSecret))
    expect(get.body.equals(payload)).toBe(true)
  })

  it('isolates channels: another channel cannot read the blob (404, no oracle)', async () => {
    const { base } = await startFileServer()
    const a = await registerDevice(base)
    const b = await registerDevice(base)
    await pairDevices(base, a, b)
    const c = await registerDevice(base)
    const d = await registerDevice(base)
    await pairDevices(base, c, d)
    const payload = Buffer.from('channel-private-blob')
    const digest = shaHex(payload)
    const put = await httpCall(
      base,
      'PUT',
      `/sync/attachments/${digest}`,
      { ...deviceHeaders(a.deviceCode, a.deviceSecret), 'content-type': 'application/octet-stream' },
      payload
    )
    expect(put.status).toBe(200)
    const cross = await httpCall(
      base,
      'GET',
      `/sync/attachments/${digest}`,
      deviceHeaders(c.deviceCode, c.deviceSecret)
    )
    expect(cross.status).toBe(404)
    expect(JSON.parse(cross.body.toString('utf8'))).toEqual({ error: 'attachment-not-found' })
  })

  it('wrong body hash is 400 digest-mismatch with no final file', async () => {
    const { base, blobDir } = await startFileServer()
    const a = await registerDevice(base)
    const b = await registerDevice(base)
    await pairDevices(base, a, b)
    const real = Buffer.from('real-content')
    const other = Buffer.from('different-content')
    const digestOfReal = shaHex(real)
    const res = await httpCall(
      base,
      'PUT',
      `/sync/attachments/${digestOfReal}`,
      { ...deviceHeaders(a.deviceCode, a.deviceSecret), 'content-type': 'application/octet-stream' },
      other
    )
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: 'digest-mismatch' })
    expect(channelFinalCount(blobDir)).toBe(0)
    const get = await httpCall(
      base,
      'GET',
      `/sync/attachments/${digestOfReal}`,
      deviceHeaders(a.deviceCode, a.deviceSecret)
    )
    expect(get.status).toBe(404)
  })

  it('malformed addresses are 400 invalid-digest (uppercase, short, empty, traversal)', async () => {
    const { base } = await startFileServer()
    const a = await registerDevice(base)
    const b = await registerDevice(base)
    await pairDevices(base, a, b)
    const auth = deviceHeaders(a.deviceCode, a.deviceSecret)
    const payload = Buffer.from('x')
    const upper = shaHex(payload).toUpperCase()
    for (const bad of [
      `/sync/attachments/${upper}`,
      '/sync/attachments/nothex',
      '/sync/attachments/',
      '/sync/attachments',
      `/sync/attachments/..%2F${shaHex(payload)}`
    ]) {
      const res = await httpCall(base, 'GET', bad, auth)
      expect(res.status).toBe(400)
      expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: 'invalid-digest' })
    }
  })

  it('malformed Content-Length is 400 length-mismatch', async () => {
    const { base } = await startFileServer()
    const a = await registerDevice(base)
    const b = await registerDevice(base)
    await pairDevices(base, a, b)
    const payload = Buffer.from('length-probe-body')
    const digest = shaHex(payload)
    for (const declared of ['not-a-number', '-5', '00']) {
      const res = await rawCallWithContentLength(
        base,
        `/sync/attachments/${digest}`,
        { ...deviceHeaders(a.deviceCode, a.deviceSecret), 'Content-Type': 'application/octet-stream' },
        declared,
        payload
      )
      expect(res.status).toBe(400)
      expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: 'length-mismatch' })
    }
  })

  it('missing asset GET is 404 attachment-not-found', async () => {
    const { base } = await startFileServer()
    const a = await registerDevice(base)
    const b = await registerDevice(base)
    await pairDevices(base, a, b)
    const digest = shaHex(Buffer.from('never-stored'))
    const res = await httpCall(base, 'GET', `/sync/attachments/${digest}`, deviceHeaders(a.deviceCode, a.deviceSecret))
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: 'attachment-not-found' })
  })

  it('device membership 403 takes precedence even with a malformed address', async () => {
    const { base } = await startFileServer()
    const a = await registerDevice(base)
    const res = await httpCall(base, 'GET', '/sync/attachments/nothex', {
      [DEVICE_CODE_HEADER]: a.deviceCode,
      [DEVICE_SECRET_HEADER]: a.deviceSecret
    })
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: 'pairing-required' })
  })

  it('unpaired caller is 403 pairing-required', async () => {
    const { base } = await startFileServer()
    const solo = await registerDevice(base)
    const digest = shaHex(Buffer.from('pairing-probe'))
    const res = await httpCall(
      base,
      'GET',
      `/sync/attachments/${digest}`,
      deviceHeaders(solo.deviceCode, solo.deviceSecret)
    )
    expect(res.status).toBe(403)
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: 'pairing-required' })
  })

  it('over-ceiling PUT is 413 attachment-too-large with no final file', async () => {
    const { base, blobDir } = await startFileServer({ maxAttachmentBytes: 8 })
    const a = await registerDevice(base)
    const b = await registerDevice(base)
    await pairDevices(base, a, b)
    const payload = Buffer.from('this body is longer than eight bytes')
    const digest = shaHex(payload)
    const res = await httpCall(
      base,
      'PUT',
      `/sync/attachments/${digest}`,
      { ...deviceHeaders(a.deviceCode, a.deviceSecret), 'content-type': 'application/octet-stream' },
      payload
    )
    expect(res.status).toBe(413)
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ error: 'attachment-too-large' })
    expect(channelFinalCount(blobDir)).toBe(0)
  })

  it('aborted partial PUT leaves no final file', async () => {
    const live = await startFileServer()
    const a = await registerDevice(live.base)
    const b = await registerDevice(live.base)
    await pairDevices(live.base, a, b)
    const payload = Buffer.alloc(64 * 1024, 0x61)
    const digest = shaHex(payload)
    await new Promise<void>((resolve) => {
      const url = new URL(`/sync/attachments/${digest}`, live.base)
      const req = httpRequest(url, {
        method: 'PUT',
        headers: {
          [DEVICE_CODE_HEADER]: a.deviceCode,
          [DEVICE_SECRET_HEADER]: a.deviceSecret
        }
      })
      req.on('error', () => resolve())
      req.write(payload.subarray(0, 1024))
      setTimeout(() => {
        try {
          req.destroy()
        } catch {}
        setTimeout(resolve, 100)
      }, 10)
    })
    expect(channelFinalCount(live.blobDir)).toBe(0)
  })

  it('restart retains blob data (file-DB close never deletes)', async () => {
    const root = tmpRoot()
    const dbPath = join(root, 'relay.db')
    const openServer = async (): Promise<LiveServer> => {
      const db = new Database(dbPath)
      dbs.push(db)
      ensureRelaySchema(db)
      const server = createRelayServer(db)
      servers.push(server as unknown as { close: (cb?: () => void) => void })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const addr = server.address() as AddressInfo
      return {
        base: `http://127.0.0.1:${addr.port}`,
        db,
        server,
        blobDir: (server as unknown as { __relayBlobDir: string }).__relayBlobDir
      }
    }
    const first = await openServer()
    const a = await registerDevice(first.base)
    const b = await registerDevice(first.base)
    await pairDevices(first.base, a, b)
    const payload = Buffer.from('retained-across-restart')
    const digest = shaHex(payload)
    const put = await httpCall(
      first.base,
      'PUT',
      `/sync/attachments/${digest}`,
      { ...deviceHeaders(a.deviceCode, a.deviceSecret), 'content-type': 'application/octet-stream' },
      payload
    )
    expect(put.status).toBe(200)
    const blobDir = first.blobDir
    expect(existsSync(blobDir)).toBe(true)
    // Close server + DB (same lifecycle as the CLI SIGTERM path: DB retained).
    const idx = servers.indexOf(first.server as unknown as { close: (cb?: () => void) => void })
    if (idx >= 0) servers.splice(idx, 1)
    await new Promise<void>((resolve) => {
      try {
        ;(first.server as unknown as { close: (cb?: () => void) => void }).close(() => resolve())
      } catch {
        resolve()
      }
    })
    try {
      first.db.close()
    } catch {}
    dbs.splice(dbs.indexOf(first.db), 1)
    // Blob data survives the close.
    expect(existsSync(blobDir)).toBe(true)
    expect(channelFinalCount(blobDir)).toBe(1)

    const second = await openServer()
    expect(second.blobDir).toBe(blobDir)
    const get = await httpCall(
      second.base,
      'GET',
      `/sync/attachments/${digest}`,
      deviceHeaders(a.deviceCode, a.deviceSecret)
    )
    expect(get.status).toBe(200)
    expect(get.body.equals(payload)).toBe(true)
  })

  it(':memory: server owns a disposable tmp blob dir cleaned up on close', async () => {
    const db = new Database(':memory:')
    dbs.push(db)
    ensureRelaySchema(db)
    const server = createRelayServer(db)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const blobDir = (server as unknown as { __relayBlobDir: string }).__relayBlobDir
    expect(blobDir.startsWith(tmpdir())).toBe(true)
    expect(existsSync(blobDir)).toBe(true)
    await new Promise<void>((resolve) => {
      try {
        ;(server as unknown as { close: (cb?: () => void) => void }).close(() => resolve())
      } catch {
        resolve()
      }
    })
    expect(existsSync(blobDir)).toBe(false)
  })

  it('streams >32MiB in bounded 64KiB chunks (never one big buffer)', async () => {
    // Raised technical ceiling for this case only: proves the path is a true
    // stream (no whole-buffer), not a product-size decision.
    const { base } = await startFileServer({ maxAttachmentBytes: 64 * 1024 * 1024 })
    const a = await registerDevice(base)
    const b = await registerDevice(base)
    await pairDevices(base, a, b)
    const total = 34 * 1024 * 1024
    const chunkSize = 64 * 1024
    const hash = createHash('sha256')
    const chunk = Buffer.alloc(chunkSize)
    for (let off = 0; off < total; off += chunkSize) {
      chunk.fill((off / chunkSize) % 251)
      hash.update(chunk)
    }
    const digest = hash.digest('hex')
    // Stream the same deterministic pattern without retaining the body.
    await new Promise<void>((resolve, reject) => {
      const url = new URL(`/sync/attachments/${digest}`, base)
      const req = httpRequest(
        url,
        {
          method: 'PUT',
          headers: {
            [DEVICE_CODE_HEADER]: a.deviceCode,
            [DEVICE_SECRET_HEADER]: a.deviceSecret,
            'content-type': 'application/octet-stream'
          }
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
          res.on('end', () => {
            try {
              expect(res.statusCode).toBe(200)
              expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toMatchObject({
                digest,
                byteLength: total,
                deduplicated: false
              })
              resolve()
            } catch (e) {
              reject(e)
            }
          })
        }
      )
      req.on('error', reject)
      let off = 0
      const pump = (): void => {
        if (off >= total) {
          req.end()
          return
        }
        const n = Math.min(chunkSize, total - off)
        const c = Buffer.alloc(n)
        c.fill((off / chunkSize) % 251)
        off += n
        if (!req.write(c)) req.once('drain', pump)
        else setImmediate(pump)
      }
      pump()
    })
    // Verify by streaming the GET through an incremental hash (no big buffer).
    const seen = createHash('sha256')
    let seenBytes = 0
    await new Promise<void>((resolve, reject) => {
      const url = new URL(`/sync/attachments/${digest}`, base)
      const req = httpRequest(
        url,
        {
          method: 'GET',
          headers: deviceHeaders(a.deviceCode, a.deviceSecret)
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`GET status ${String(res.statusCode)}`))
            return
          }
          res.on('data', (c: Buffer) => {
            seenBytes += c.length
            seen.update(c)
          })
          res.on('end', () => resolve())
          res.on('error', reject)
        }
      )
      req.on('error', reject)
      req.end()
    })
    expect(seenBytes).toBe(total)
    expect(seen.digest('hex')).toBe(digest)
  }, 60000)

  it('non-attachment routes return false (fall through)', async () => {
    const dir = tmpRoot()
    const handled = await handleAttachmentRequest(
      { url: '/sync/push', headers: {}, on: () => undefined, removeListener: () => undefined } as never,
      { writableEnded: true, destroyed: true } as never,
      {
        blobDir: dir,
        resolveCaller: () => {
          throw new Error('must not be called for non-attachment routes')
        }
      }
    )
    expect(handled).toBe(false)
    void randomBytes
  })
})
