/**
 * Relay per-channel attachment bytes resource — bounded independent helper.
 *
 * Scope: binary `PUT /sync/attachments/<sha256>` + `GET /sync/attachments/<sha256>`
 * for the reference sync relay only. Must NOT be imported by production app code.
 * Server wiring (`scripts/sync-relay/server.ts` registration) is owned by this
 * unit; this module has no side effects on import.
 *
 * Design (locked for this unit):
 * - No `packages/shared/sync/*` imports (another writer owns shared validators,
 *   types, baseline, and core) and no `server.ts` imports. Auth is injected via
 *   callbacks so the relay's existing device/channel semantics stay
 *   owned by the server.
 * - Durability is the operator-owned relay blob dir on the filesystem, NOT
 *   SQLite BLOBs and NOT whole-buffer memory: the request stream is written
 *   incrementally to a `0600` temp file (`wx` create) while SHA-256 hashing
 *   incrementally; only after the digest verifies does the temp file atomically
 *   rename to its final name. No chunking protocol, no GC, no auto-delete
 *   (full retention; old-file deletion is not part of this unit).
 * - Layout derives from the authenticated channel only, never from user paths:
 *   `<blobDir>/ch-<sha256(channelId)>/<sha256 digest>`. Directory names are
 *   safe hashes, file names are validated lowercase-hex digests — no path
 *   joins from request input, no traversal, no symlinks (finals are verified
 *   regular files via `O_NOFOLLOW` open + fstat).
 * - This module keeps NO SQLite metadata: the filesystem final name (digest)
 *   plus `stat` size is the single source of truth, so there is no extra state
 *   to drift into dangling fakes. A final file is declared ready only by the
 *   atomic rename after digest verification; temp names (`.*.part-*`) are never
 *   served and are always cleaned up on abort/mismatch/failure.
 * - Memory is bounded: the body is never buffered in full. The technical
 *   `maxAttachmentBytes` ceiling is an implementation safety bound with an
 *   explicit truthful refusal (413 `attachment-too-large`), NOT a product cap:
 *   the relay never silently truncates, and disk-space failure (`ENOSPC`)
 *   surfaces as 500 `store-unavailable` so the client keeps the transfer
 *   pending for a later retry.
 * - Auth precedence mirrors the relay data plane: device credential `403`,
 *   then unpaired `403 pairing-required`. Digest format/body errors are
 *   `400` only after auth passes.
 * - No transaction is held across the network: the only commit is the atomic
 *   rename after the stream completes and verifies. Dedup replays verify the
 *   existing final (regular file, size coherence) and store nothing new.
 */

import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, join, resolve } from 'node:path'

export const ATTACHMENT_ROUTE_PREFIX = '/sync/attachments/'

/** Strict address form: lowercase hex SHA-256 (64 chars). Uppercase is rejected, never coerced. */
export const ATTACHMENT_DIGEST_RE = /^[0-9a-f]{64}$/

/**
 * Default stream byte ceiling for one attachment in this unit.
 * No arbitrary product cap: the default is the largest declarable safe
 * stream ceiling (Number.MAX_SAFE_INTEGER) and the body is never buffered
 * in full (incremental stream to temp + incremental hash). An operator
 * opt-in `maxAttachmentBytes` (valid positive safe integer) keeps the same
 * truthful refusal (413 `attachment-too-large`, never truncate); natural
 * streaming disk failure surfaces as 500 `store-unavailable`.
 */
export const DEFAULT_MAX_ATTACHMENT_BYTES = Number.MAX_SAFE_INTEGER

export interface AttachmentCaller {
  deviceCode: string
  channelId: string | null
}

export interface AttachmentContext {
  /**
   * Operator-owned relay blob dir (directory; finals live under per-channel
   * safe-hash subdirs). Derived from the file-DB adjacent namespace by the
   * server (`defaultRelayBlobDirForDbPath`); `:memory:` servers pass an owned
   * disposable tmp dir with close-cleanup ownership.
   */
  blobDir: string
  /**
   * Resolve the device-authenticated caller. Throw `{ status, error }` for HTTP
   * mapping (server's `requireDeviceAuthOrThrow` shape): `status: 500` maps to
   * `store-unavailable`, anything else maps to `403` with the thrown `error`.
   */
  resolveCaller: (req: IncomingMessage) => AttachmentCaller | Promise<AttachmentCaller>
  /** Per-request bound override; defaults to DEFAULT_MAX_ATTACHMENT_BYTES. Must be a positive safe integer. */
  maxAttachmentBytes?: number
}

export interface AttachmentPutResult {
  digest: string
  byteLength: number
  /** True when the (channel, digest) final already existed — replay stored nothing new. */
  deduplicated: boolean
}

/**
 * Default operator-owned blob dir adjacent to the relay file DB:
 * `<dirname(dbPath)>/<basename(dbPath)>.attachments`. Never a user-data path,
 * never deleted on normal server close (file-DB blob data is retained).
 */
export function defaultRelayBlobDirForDbPath(dbPath: string): string {
  const normalized = resolve(dbPath)
  return join(dirname(normalized), `${basename(normalized)}.attachments`)
}

/** Ensure the operator-owned blob root exists (idempotent, keeps existing rows). */
export async function ensureRelayBlobDir(blobDir: string): Promise<void> {
  await mkdir(resolve(blobDir), { recursive: true, mode: 0o700 })
}

function channelDirName(channelId: string): string {
  return `ch-${createHash('sha256').update(channelId, 'utf8').digest('hex')}`
}

function isSafePositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0
}

function resolveMaxBytes(ctx: AttachmentContext): number {
  if (ctx.maxAttachmentBytes === undefined) return DEFAULT_MAX_ATTACHMENT_BYTES
  if (!isSafePositiveInt(ctx.maxAttachmentBytes)) return DEFAULT_MAX_ATTACHMENT_BYTES
  return ctx.maxAttachmentBytes
}

function matchAttachmentPath(pathname: string): { digest: string } | { malformed: true } | null {
  if (pathname === '/sync/attachments' || pathname === '/sync/attachments/') return { malformed: true }
  if (!pathname.startsWith(ATTACHMENT_ROUTE_PREFIX)) return null
  const rest = pathname.slice(ATTACHMENT_ROUTE_PREFIX.length)
  if (rest.length === 0 || rest.includes('/')) return { malformed: true }
  let digest = rest
  try {
    digest = decodeURIComponent(rest)
  } catch {
    return { malformed: true }
  }
  if (!ATTACHMENT_DIGEST_RE.test(digest)) return { malformed: true }
  return { digest }
}

function jsonError(res: ServerResponse, status: number, error: string): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error }))
}

function readContentLength(req: IncomingMessage): { present: boolean; value: number | null; malformed: boolean } {
  const raw = req.headers['content-length']
  const first = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
  if (typeof first !== 'string' || first.length === 0) return { present: false, value: null, malformed: false }
  // Strict canonical decimal: no whitespace, no leading zeros (except `0` itself).
  if (!/^(0|[1-9][0-9]*)$/.test(first)) return { present: true, value: null, malformed: true }
  const n = Number(first)
  if (!Number.isSafeInteger(n) || n < 0) return { present: true, value: null, malformed: true }
  return { present: true, value: n, malformed: false }
}

interface StreamedBody {
  /** Temp file still on disk (caller must unlink or rename). */
  tempPath: string
  byteLength: number
  digestHex: string
  aborted: boolean
  tooLarge: boolean
  storeFailed: boolean
}

/**
 * Stream the request body to a `0600` temp file (exclusive `wx` create) while
 * hashing incrementally. Bounded memory: the async iterator applies natural
 * backpressure (each chunk is written before the next is read), chunks are
 * written through and never buffered. Past the ceiling the socket keeps
 * draining (without writing) so the connection stays reusable, then the temp
 * file is removed and `tooLarge` reports. Abort/close mid-body throws out of
 * the iterator → temp removed, `aborted` (never declare ready). `ENOSPC` /
 * write failure removes the temp file and reports `storeFailed`.
 */
async function streamBodyToTemp(
  req: IncomingMessage,
  channelDir: string,
  digest: string,
  maxBytes: number
): Promise<StreamedBody> {
  const tempPath = join(channelDir, `.${digest}.${randomBytes(8).toString('hex')}.part`)
  const hash = createHash('sha256')
  let byteLength = 0
  let tooLarge = false

  const cleanupTemp = async (): Promise<void> => {
    try {
      await unlink(tempPath)
    } catch {}
  }

  // Exclusive create, owner-only. No symlink following on create.
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
  } catch {
    return { tempPath, byteLength: 0, digestHex: '', aborted: false, tooLarge: false, storeFailed: true }
  }

  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array)
      byteLength += buf.length
      if (byteLength > maxBytes) {
        // Keep draining without writing or hashing past the ceiling.
        tooLarge = true
        continue
      }
      hash.update(buf)
      try {
        await handle.write(buf)
      } catch {
        try {
          await handle.close()
        } catch {}
        handle = null
        await cleanupTemp()
        return { tempPath, byteLength, digestHex: '', aborted: false, tooLarge: false, storeFailed: true }
      }
    }
  } catch {
    try {
      await handle?.close()
    } catch {}
    await cleanupTemp()
    return { tempPath, byteLength, digestHex: '', aborted: true, tooLarge, storeFailed: false }
  }

  try {
    await handle.close()
  } catch {
    handle = null
    await cleanupTemp()
    return { tempPath, byteLength, digestHex: '', aborted: false, tooLarge: false, storeFailed: true }
  }
  handle = null

  if (tooLarge) {
    await cleanupTemp()
    return { tempPath, byteLength, digestHex: '', aborted: false, tooLarge: true, storeFailed: false }
  }
  let digestHex = ''
  try {
    digestHex = hash.digest('hex')
  } catch {
    await cleanupTemp()
    return { tempPath, byteLength, digestHex: '', aborted: false, tooLarge: false, storeFailed: true }
  }
  return { tempPath, byteLength, digestHex, aborted: false, tooLarge: false, storeFailed: false }
}

async function finalIsCoherent(finalPath: string, byteLength: number): Promise<boolean> {
  try {
    const st = await stat(finalPath)
    if (!st.isFile()) return false
    if (!Number.isSafeInteger(st.size) || st.size !== byteLength) return false
    return true
  } catch {
    return false
  }
}

/**
 * Handle one attachment route. Returns `false` when the request is not an
 * attachment route (caller should fall through to the next handler);
 * otherwise sends exactly one response (or none when the client already went
 * away) and returns `true`.
 */
export async function handleAttachmentRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AttachmentContext
): Promise<boolean> {
  let pathname = '/'
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    pathname = url.pathname
  } catch {
    return false
  }
  const match = matchAttachmentPath(pathname)
  if (match === null) return false

  const maxBytes = resolveMaxBytes(ctx)

  // Device-first auth (relay data-plane order): device credential 403,
  // then channel membership 403.
  let caller: AttachmentCaller
  try {
    caller = await ctx.resolveCaller(req)
  } catch (e) {
    const te = e as { status?: number; error?: string }
    if (typeof te?.status === 'number' && te.status === 500) {
      jsonError(res, 500, 'store-unavailable')
      return true
    }
    jsonError(res, 403, typeof te?.error === 'string' && te.error.length > 0 ? te.error : 'invalid-credential')
    return true
  }
  if (!caller || typeof caller.deviceCode !== 'string' || caller.channelId === null || caller.channelId === undefined) {
    jsonError(res, 403, 'pairing-required')
    return true
  }
  const channelId = caller.channelId
  if (typeof channelId !== 'string' || channelId.length === 0) {
    jsonError(res, 403, 'pairing-required')
    return true
  }

  if ('malformed' in match) {
    jsonError(res, 400, 'invalid-digest')
    return true
  }
  const digest = match.digest

  const blobRoot = resolve(ctx.blobDir)
  const channelDir = join(blobRoot, channelDirName(channelId))
  const finalPath = join(channelDir, digest)

  if (req.method === 'PUT') {
    const contentLength = readContentLength(req)
    if (contentLength.malformed) {
      req.resume()
      jsonError(res, 400, 'length-mismatch')
      return true
    }
    // Early Content-Length refusal still drains the socket.
    if (contentLength.present && contentLength.value !== null && contentLength.value > maxBytes) {
      req.resume()
      jsonError(res, 413, 'attachment-too-large')
      return true
    }
    let dirReady = true
    try {
      await mkdir(channelDir, { recursive: true, mode: 0o700 })
    } catch {
      dirReady = false
    }
    if (!dirReady) {
      req.resume()
      jsonError(res, 500, 'store-unavailable')
      return true
    }
    const body = await streamBodyToTemp(req, channelDir, digest, maxBytes)
    if (body.aborted || req.aborted) return true
    if (res.destroyed || res.writableEnded) {
      try {
        await unlink(body.tempPath)
      } catch {}
      return true
    }
    if (body.storeFailed) {
      jsonError(res, 500, 'store-unavailable')
      return true
    }
    if (body.tooLarge) {
      jsonError(res, 413, 'attachment-too-large')
      return true
    }
    if (contentLength.present && contentLength.value !== null && contentLength.value !== body.byteLength) {
      try {
        await unlink(body.tempPath)
      } catch {}
      jsonError(res, 400, 'length-mismatch')
      return true
    }
    if (body.digestHex !== digest) {
      try {
        await unlink(body.tempPath)
      } catch {}
      jsonError(res, 400, 'digest-mismatch')
      return true
    }
    if (!Number.isSafeInteger(body.byteLength) || body.byteLength < 0) {
      try {
        await unlink(body.tempPath)
      } catch {}
      jsonError(res, 500, 'store-unavailable')
      return true
    }
    // Dedup: an existing coherent final stores nothing new (immutable content —
    // the verified digest equals the final name, so equal size means identical
    // bytes; a size mismatch on an existing final is store corruption).
    let deduplicated = false
    let existing: Awaited<ReturnType<typeof stat>> | null = null
    let statErr: NodeJS.ErrnoException | null = null
    try {
      existing = await stat(finalPath)
    } catch (e) {
      statErr = e as NodeJS.ErrnoException
    }
    if (statErr && statErr.code !== 'ENOENT') {
      try {
        await unlink(body.tempPath)
      } catch {}
      jsonError(res, 500, 'store-unavailable')
      return true
    }
    if (!statErr && existing) {
      if (!existing.isFile() || !Number.isSafeInteger(existing.size) || existing.size !== body.byteLength) {
        try {
          await unlink(body.tempPath)
        } catch {}
        jsonError(res, 500, 'store-unavailable')
        return true
      }
      deduplicated = true
      try {
        await unlink(body.tempPath)
      } catch {}
    } else {
      // Absent final: atomic commit. A lost-race EEXIST falls back to the
      // coherent-dedup check (never overwrites an existing final).
      try {
        await rename(body.tempPath, finalPath)
      } catch (re) {
        if ((re as NodeJS.ErrnoException)?.code === 'ENOSPC') {
          try {
            await unlink(body.tempPath)
          } catch {}
          jsonError(res, 500, 'store-unavailable')
          return true
        }
        const coherent = await finalIsCoherent(finalPath, body.byteLength)
        try {
          await unlink(body.tempPath)
        } catch {}
        if (!coherent) {
          jsonError(res, 500, 'store-unavailable')
          return true
        }
        deduplicated = true
      }
    }
    if (res.writableEnded || res.destroyed) return true
    const result: AttachmentPutResult = { digest, byteLength: body.byteLength, deduplicated }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
    return true
  }

  if (req.method === 'GET') {
    let st: Awaited<ReturnType<typeof stat>> | null = null
    try {
      st = await stat(finalPath)
    } catch {
      // Channel-scoped 404: the same spelling whether the digest is unknown
      // globally or only absent from the caller's channel (no cross-channel oracle).
      jsonError(res, 404, 'attachment-not-found')
      return true
    }
    if (!st.isFile() || !Number.isSafeInteger(st.size) || st.size < 0) {
      jsonError(res, 500, 'store-unavailable')
      return true
    }
    const size = st.size
    // Open with O_NOFOLLOW semantics: reject symlinks/dirs, serve only the
    // verified regular final. `stat` + `open(r)` is not atomic, so re-fstat
    // the handle and compare before streaming.
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(finalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      const fst = await handle.stat()
      if (!fst.isFile() || fst.size !== size) {
        try {
          await handle.close()
        } catch {}
        jsonError(res, 500, 'store-unavailable')
        return true
      }
    } catch {
      try {
        await handle?.close()
      } catch {}
      jsonError(res, 404, 'attachment-not-found')
      return true
    }
    // Handle-owned stream: the fd stays owned by `owned` and the stream
    // closes it exactly once (no separate fd handoff, no double close).
    const owned = handle
    handle = null
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size)
    })
    const stream = owned.createReadStream()
    stream.on('error', () => {
      try {
        if (!res.writableEnded) res.destroy()
      } catch {}
    })
    req.on('close', () => {
      try {
        stream.destroy()
      } catch {}
    })
    stream.pipe(res)
    return true
  }

  jsonError(res, 405, 'method-not-allowed')
  return true
}
