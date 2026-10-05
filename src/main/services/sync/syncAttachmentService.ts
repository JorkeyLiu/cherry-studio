/**
 * Main-process sync attachment transfer service (bounded unit).
 *
 * Narrow byte-transfer only: discover portable metadata for trusted stored
 * files, stream uploads through SyncClient, stream downloads into an owned
 * tmp file and atomically install into the local files dir. File paths are
 * always localized (rebuilt here) and never travel on the wire.
 *
 * Confinement:
 * - Only `id + ext` basenames resolved inside `filesDir` via the shared
 *   `validateStoredFilePath` production helper (rejects absolute paths,
 *   traversal, symlinks, directories). External user file input is never
 *   accepted — there is no absolute-path branch.
 * - No scheduler, no database ownership, no Dexie writes: transfer is invoked
 *   per call by the later SyncService/integrator wiring, which also owns
 *   block→assetRef projection (shared `projectPortableMediaRefs`) and pending
 *   bookkeeping. Failures throw so the caller retains the transfer as pending.
 * - Logging goes through `loggerService` only and never carries credential
 *   material (device secrets) or secret paths — only asset ids,
 *   digests, and sizes.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { loggerService } from '@logger'
import { validateStoredFilePath } from '@main/utils/fileValidator'
import type { FileAsset } from '@shared/sync/attachments'
import { ATTACHMENT_DIGEST_RE, mimeTypeForExtension, validateFileAsset } from '@shared/sync/attachments'

const logger = loggerService.withContext('SyncAttachmentService')

export interface SyncAttachmentClient {
  uploadAttachment(
    endpoint: string,
    args: { digest: string; byteLength?: number; body: unknown },
    deviceCode: string,
    deviceSecret: string,
    externalSignal?: AbortSignal
  ): Promise<{ digest: string; byteLength: number; deduplicated: boolean }>
  downloadAttachment(
    endpoint: string,
    args: { digest: string; expectedByteLength?: number },
    deviceCode: string,
    deviceSecret: string,
    externalSignal?: AbortSignal,
    onChunk?: (chunk: Uint8Array) => void | Promise<void>
  ): Promise<{ digest: string; byteLength: number }>
}

export interface SyncAttachmentServiceDeps {
  /** Trusted local stored-files dir (FileStorage filesDir). */
  filesDir: string
  /** Owned temp dir for in-flight downloads. */
  tempDir: string
  client: SyncAttachmentClient
  /** Override for tests; default is the shared production validator. */
  resolveStoredFile?: (storedFileName: string) => Promise<string | null>
}

export interface AssetDisplayHints {
  originalName?: string
  createdAt?: string
}

export interface InstalledAttachment {
  /** Portable wire metadata (non-secret). */
  asset: FileAsset
  /** Localized rebuilt path (never on the wire). */
  localPath: string
  /** True when an identical stored file already existed. */
  deduplicated: boolean
}

function assertSafeByteLength(n: unknown, where: string): number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${where} failed: invalid byteLength`)
  }
  return n
}

async function hashStoredFile(filePath: string): Promise<{ sha256: string; byteLength: number }> {
  const hash = createHash('sha256')
  let byteLength = 0
  const stream = createReadStream(filePath)
  try {
    for await (const chunk of stream as unknown as AsyncIterable<Buffer>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      byteLength += buf.length
      hash.update(buf)
    }
  } catch (e) {
    throw new Error(`asset discover failed: unreadable stored file (${(e as Error).message.slice(0, 120)})`)
  }
  return { sha256: hash.digest('hex'), byteLength }
}

export class SyncAttachmentService {
  private readonly filesDir: string
  private readonly tempDir: string
  private readonly client: SyncAttachmentClient
  private readonly resolveStoredFile: (storedFileName: string) => Promise<string | null>

  constructor(deps: SyncAttachmentServiceDeps) {
    if (!deps || typeof deps.filesDir !== 'string' || deps.filesDir.length === 0) {
      throw new Error('SyncAttachmentService requires filesDir')
    }
    if (!deps || typeof deps.tempDir !== 'string' || deps.tempDir.length === 0) {
      throw new Error('SyncAttachmentService requires tempDir')
    }
    if (!deps.client) throw new Error('SyncAttachmentService requires client')
    this.filesDir = resolve(deps.filesDir)
    this.tempDir = resolve(deps.tempDir)
    this.client = deps.client
    const filesDir = this.filesDir
    this.resolveStoredFile = deps.resolveStoredFile ?? ((name: string) => validateStoredFilePath(filesDir, name))
  }

  /**
   * Discover portable metadata (+ content hash) for one trusted stored file.
   * `storedFileName` is the `id + ext` basename; anything else (absolute
   * paths, traversal, symlinks, directories, missing files) throws.
   */
  async discoverAsset(storedFileName: string, hints?: AssetDisplayHints): Promise<FileAsset> {
    if (typeof storedFileName !== 'string' || storedFileName.length === 0) {
      throw new Error('asset discover failed: invalid stored file name')
    }
    const resolved = await this.resolveStoredFile(storedFileName)
    if (!resolved) throw new Error('asset discover failed: stored file unavailable')
    const dot = storedFileName.lastIndexOf('.')
    if (dot <= 0) throw new Error('asset discover failed: stored file name missing extension')
    const id = storedFileName.slice(0, dot)
    const extension = storedFileName.slice(dot).toLowerCase()
    if (id.length === 0 || id.includes('/') || id.includes('\\') || id.includes('..')) {
      throw new Error('asset discover failed: invalid stored file name')
    }
    const { sha256, byteLength } = await hashStoredFile(resolved)
    if (!ATTACHMENT_DIGEST_RE.test(sha256)) throw new Error('asset discover failed: hash invalid')
    assertSafeByteLength(byteLength, 'asset discover')
    const originalName =
      typeof hints?.originalName === 'string' &&
      hints.originalName.length > 0 &&
      hints.originalName.length <= 255 &&
      !hints.originalName.includes('/') &&
      !hints.originalName.includes('\\')
        ? hints.originalName
        : storedFileName
    let createdAt = typeof hints?.createdAt === 'string' ? hints.createdAt : ''
    if (!createdAt || !Number.isFinite(Date.parse(createdAt))) {
      try {
        const st = await stat(resolved)
        const birth = st.birthtime instanceof Date ? st.birthtime.getTime() : NaN
        createdAt = Number.isFinite(birth) && birth > 0 ? st.birthtime.toISOString() : st.mtime.toISOString()
      } catch {
        createdAt = new Date().toISOString()
      }
    }
    const asset: FileAsset = {
      id,
      sha256,
      byteLength,
      extension,
      mimeType: mimeTypeForExtension(extension),
      originalName,
      createdAt
    }
    const err = validateFileAsset(asset)
    if (err) throw new Error(`asset discover failed: ${err}`)
    logger.debug(`discovered attachment asset id=${id} bytes=${byteLength} sha256=${sha256.slice(0, 12)}…`)
    return asset
  }

  /**
   * Stream-upload one trusted stored asset. The stored bytes must hash/length
   * match the asset (stale metadata throws and stays pending). Returns the
   * relay receipt; failures throw for the caller to retain as pending.
   */
  async uploadAsset(
    asset: FileAsset,
    endpoint: string,
    deviceCode: string,
    deviceSecret: string,
    externalSignal?: AbortSignal
  ): Promise<{ digest: string; byteLength: number; deduplicated: boolean }> {
    const err = validateFileAsset(asset)
    if (err) throw new Error(`attachment upload failed: ${err}`)
    const resolved = await this.resolveStoredFile(`${asset.id}${asset.extension}`)
    if (!resolved) throw new Error('attachment upload failed: stored file unavailable')
    const st = await stat(resolved).catch(() => null)
    if (!st || !st.isFile()) throw new Error('attachment upload failed: stored file unavailable')
    if (!Number.isSafeInteger(st.size) || st.size !== asset.byteLength) {
      throw new Error('attachment upload failed: stored size changed (stale metadata)')
    }
    const body = createReadStream(resolved)
    const forwardError = new Promise<never>((_, reject) => {
      body.on('error', (e: Error) =>
        reject(new Error(`attachment upload failed: unreadable stored file (${e.message.slice(0, 120)})`))
      )
    })
    try {
      const receipt = await Promise.race([
        this.client.uploadAttachment(
          endpoint,
          { digest: asset.sha256, byteLength: asset.byteLength, body },
          deviceCode,
          deviceSecret,
          externalSignal
        ),
        forwardError
      ])
      logger.debug(
        `uploaded attachment id=${asset.id} bytes=${receipt.byteLength} deduplicated=${receipt.deduplicated}`
      )
      return receipt
    } finally {
      try {
        body.destroy()
      } catch {}
    }
  }

  /**
   * Stream-download one asset into an owned tmp file (verified incrementally
   * by the client), then atomically install into `filesDir`. Missing/corrupt
   * content rolls back: the tmp file is removed and `filesDir` is never left
   * partial (pre-existing finals are never overwritten). Returns the localized
   * install projection (portable metadata + distinct local path).
   */
  async downloadAndInstall(
    asset: FileAsset,
    endpoint: string,
    deviceCode: string,
    deviceSecret: string,
    externalSignal?: AbortSignal
  ): Promise<InstalledAttachment> {
    const err = validateFileAsset(asset)
    if (err) throw new Error(`attachment download failed: ${err}`)
    try {
      await mkdir(this.tempDir, { recursive: true })
    } catch {
      throw new Error('attachment download failed: temp dir unavailable')
    }
    const tmpPath = join(this.tempDir, `sync-attach-${randomBytes(8).toString('hex')}.part`)
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    } catch {
      throw new Error('attachment download failed: temp file unavailable')
    }
    const rollback = async (): Promise<void> => {
      try {
        await handle?.close()
      } catch {}
      handle = null
      try {
        await unlink(tmpPath)
      } catch {}
    }
    try {
      // Explicit local guards: `rollback` assigns the outer `handle`, so the
      // outer binding is never narrowed — bind and check locally instead.
      const writeHandle = handle
      if (!writeHandle) throw new Error('attachment download failed: temp file unavailable')
      const fileStream = createWriteStreamSafe(writeHandle)
      await this.client.downloadAttachment(
        endpoint,
        { digest: asset.sha256, expectedByteLength: asset.byteLength },
        deviceCode,
        deviceSecret,
        externalSignal,
        async (chunk: Uint8Array) => {
          await fileStream.writeChunk(chunk)
        }
      )
      await fileStream.finish()
      const closeHandle = handle
      handle = null
      if (closeHandle) {
        try {
          await closeHandle.close()
        } catch {}
      }
      const tmpStat = await stat(tmpPath).catch(() => null)
      if (!tmpStat || !tmpStat.isFile() || tmpStat.size !== asset.byteLength) {
        await rollback().catch(() => undefined)
        throw new Error('attachment download failed: length-mismatch')
      }
      // Safe by construction: asset id/extension are strictly validated
      // (no separators, no traversal), so the join stays inside filesDir.
      const finalName = `${asset.id}${asset.extension}`
      const finalPath = join(this.filesDir, finalName)
      let existing: Awaited<ReturnType<typeof stat>> | null = null
      try {
        existing = await stat(finalPath)
      } catch {
        existing = null
      }
      if (existing) {
        if (!existing.isFile()) {
          await rollback().catch(() => undefined)
          throw new Error('attachment install failed: stored path conflict')
        }
        // Immutable stored content: verify the existing final before dedup.
        const existingHash = await hashStoredFile(finalPath)
        if (existingHash.sha256 !== asset.sha256 || existingHash.byteLength !== asset.byteLength) {
          await rollback().catch(() => undefined)
          throw new Error('attachment install failed: stored content conflict')
        }
        await unlink(tmpPath).catch(() => undefined)
        logger.debug(`installed attachment id=${asset.id} deduplicated=true`)
        return { asset, localPath: finalPath, deduplicated: true }
      }
      try {
        await mkdir(this.filesDir, { recursive: true })
      } catch {
        await rollback().catch(() => undefined)
        throw new Error('attachment install failed: files dir unavailable')
      }
      try {
        await rename(tmpPath, finalPath)
      } catch (e) {
        // Lost race: re-check the final instead of overwriting.
        const raced = await stat(finalPath).catch(() => null)
        if (raced && raced.isFile() && raced.size === asset.byteLength) {
          const racedHash = await hashStoredFile(finalPath)
          await unlink(tmpPath).catch(() => undefined)
          if (racedHash.sha256 !== asset.sha256) {
            throw new Error('attachment install failed: stored content conflict')
          }
          return { asset, localPath: finalPath, deduplicated: true }
        }
        await rollback().catch(() => undefined)
        throw new Error(`attachment install failed: rename unavailable (${(e as Error).message.slice(0, 120)})`)
      }
      logger.debug(`installed attachment id=${asset.id} bytes=${asset.byteLength} deduplicated=false`)
      return { asset, localPath: finalPath, deduplicated: false }
    } catch (e) {
      await rollback().catch(() => undefined)
      throw e
    } finally {
      if (handle) {
        try {
          await handle.close()
        } catch {}
        try {
          await unlink(tmpPath)
        } catch {}
      }
    }
  }
}

function createWriteStreamSafe(handle: Awaited<ReturnType<typeof open>>): {
  writeChunk: (chunk: Uint8Array) => Promise<void>
  finish: () => Promise<void>
} {
  const pending: Array<{ chunk: Uint8Array; resolve: () => void; reject: (e: Error) => void }> = []
  let failed: Error | null = null
  let finished = false
  let pumping = false
  const pump = async (): Promise<void> => {
    // Single-flight: ordered file-position writes even if callers overlap.
    if (pumping) return
    pumping = true
    try {
      while (pending.length > 0 && !failed) {
        const item = pending.shift()
        if (!item) break
        try {
          await handle.write(Buffer.from(item.chunk.buffer, item.chunk.byteOffset, item.chunk.byteLength))
          item.resolve()
        } catch (e) {
          failed = e instanceof Error ? e : new Error(String(e))
          item.reject(failed)
          break
        }
      }
    } finally {
      pumping = false
    }
  }
  return {
    writeChunk: (chunk: Uint8Array): Promise<void> => {
      if (failed) return Promise.reject(failed)
      return new Promise<void>((resolve, reject) => {
        pending.push({ chunk, resolve, reject })
        void pump()
      })
    },
    finish: async (): Promise<void> => {
      await pump()
      if (failed) throw failed
      if (finished) return
      finished = true
      await handle.sync().catch(() => undefined)
    }
  }
}

export function buildSyncAttachmentService(deps: SyncAttachmentServiceDeps): SyncAttachmentService {
  return new SyncAttachmentService(deps)
}
