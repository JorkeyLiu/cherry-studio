/**
 * Portable media read assembly (Main chat authority, read-only).
 *
 * Receiver problem: v5 synced file/image/video blocks arrive with
 * `message_blocks.extra = NULL` (no `overflow.file`) while the trusted
 * association (`file_references`) plus portable metadata (`sync_file_asset`)
 * plus already-installed `Files/<id><ext>` bytes exist. The pre-fix read
 * chain (`blocks.listByMessages -> blocksToWire -> overflow.file`) therefore
 * emits `file = null` and the renderer shows nothing.
 *
 * This module hydrates `block.overflow.file` in memory from trusted DB rows
 * only — no replay, no migration, no manual DB repair:
 * - Portable block types only (`file`/`image`/`video`, case-insensitive).
 * - Existing `overflow.file` is preserved (local/import semantics untouched).
 * - One trusted `file_references` row per block (first safe fileId, sorted
 *   deterministic) plus its matching `sync_file_asset` row are required;
 *   missing/illegal input stays `null` (expected fail-safe, never forged;
 *   multi-ref first-missing stays `null` and never falls through to a later
 *   valid asset — conservative fail-closed, not a product selection).
 * - The emitted `path` is always rebuilt inside the LOCAL files dir
 *   (`<filesDir>/<id><ext>`); sender absolute paths and stored
 *   `file_references.file_path` values are never copied (no path leak).
 * - No new schema/wire/protocol: the output shape is the existing renderer
 *   `FileMetadata` (`id/name/origin_name/path/size/ext/type/created_at/count`).
 * - Error contract: expected fail-safe (no refs/asset, invalid ids/ext/names)
 *   returns with `null` preserved; real DB/infra failures (select throws,
 *   files-dir unavailable, unexpected per-block exception) THROW and propagate
 *   to the caller's `wrapResult` failure path (existing `errors.ts` sanitized
 *   logging, generic wire message, no content/path logs, no path on the wire).
 *   This helper emits no logs itself.
 */

import { join } from 'node:path'

import { getFilesDir } from '@main/utils/file'
import { audioExts, documentExts, imageExts, textExts, videoExts } from '@shared/config/constant'
import { inArray } from 'drizzle-orm'

import type { MessageBlockData } from './domain/types'
import * as schema from './schema'

type TxLike = {
  select: (...args: never[]) => unknown
} & Record<string, unknown>

interface HydrateRefs {
  refsByBlock: Map<string, string[]>
  countsByRef: Map<string, number>
  assetsById: Map<
    string,
    {
      byteLength: number
      extension: string
      originalName: string
      createdAt: string
    }
  >
}

const PORTABLE_MEDIA_TYPES: ReadonlySet<string> = new Set(['file', 'image', 'video'])

function isPortableMediaType(type: string | null | undefined): boolean {
  if (typeof type !== 'string') return false
  return PORTABLE_MEDIA_TYPES.has(type.toLowerCase())
}

function hasExistingFileValue(block: MessageBlockData): boolean {
  const v = (block.overflow as Record<string, unknown> | null | undefined)?.file
  if (v === null || v === undefined) return false
  // Any pre-existing value (valid local/import DTO or degraded marker payload)
  // wins over hydration: local/import semantics are never overwritten.
  return true
}

function isSafeFileId(id: unknown): id is string {
  if (typeof id !== 'string') return false
  if (id.length === 0 || id.length > 256) return false
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return false
  if (id.trim() !== id) return false
  // Consistent with the portable protocol validator
  // (`packages/shared/sync/attachments.ts` `isValidAssetId`: 1..256, no
  // separators/traversal, no surrounding whitespace) without opening a bypass:
  // helper-accepted ids are a subset of protocol-accepted ids. NUL/control
  // (including DEL) are additionally fail-closed here so a hostile stored id
  // can never reach the local path join; overlong is already rejected above.

  if (/[\u0000-\u001F\u007F]/.test(id)) return false
  return true
}

function normalizeExtension(ext: unknown): string | null {
  if (typeof ext !== 'string' || ext.length === 0) return null
  let e = ext.toLowerCase()
  if (!e.startsWith('.')) e = `.${e}`
  if (e.length < 2 || e.length > 16) return null
  if (!/^\.[a-z0-9]+$/.test(e)) return null
  return e
}

function isValidOriginalName(v: unknown): v is string {
  if (typeof v !== 'string') return false
  if (v.length === 0 || v.length > 255) return false
  if (v.includes('/') || v.includes('\\')) return false
  if (v === '.' || v === '..') return false
  if (v.trim().length === 0) return false
  return true
}

function fileTypeForExtension(ext: string): string {
  const e = ext.toLowerCase()
  if ((imageExts as readonly string[]).includes(e)) return 'image'
  if ((videoExts as readonly string[]).includes(e)) return 'video'
  if ((audioExts as readonly string[]).includes(e)) return 'audio'
  if ((textExts as readonly string[]).includes(e)) return 'text'
  if ((documentExts as readonly string[]).includes(e)) return 'document'
  return 'other'
}

function resolveFilesDir(): string {
  // Infra: an unavailable files dir must fail the read explicitly via the
  // caller's wrapResult path — never degrade to ok + file null.
  const dir = getFilesDir()
  if (typeof dir === 'string' && dir.length > 0) return dir
  throw new Error('media hydration failed: files dir unavailable')
}

function readHydrateRefs(tx: unknown, blockIds: string[]): HydrateRefs {
  const empty: HydrateRefs = { refsByBlock: new Map(), countsByRef: new Map(), assetsById: new Map() }
  if (blockIds.length === 0) return empty
  const dbTx = tx as {
    select: (cols: unknown) => {
      from: (t: unknown) => { where: (c: unknown) => { all: () => Array<Record<string, unknown>> } }
    }
  }
  // Infra failures (select/where/all throws) propagate to the caller's
  // wrapResult failure path — never degraded to ok + file null. Only
  // per-row invalid ids/counts below are explicit-validation fail-safe.
  const refRows = dbTx
    .select({
      blockId: schema.fileReferences.blockId,
      fileId: schema.fileReferences.fileId,
      count: schema.fileReferences.count
    })
    .from(schema.fileReferences)
    .where(inArray(schema.fileReferences.blockId, blockIds))
    .all()
  const refsByBlock = new Map<string, string[]>()
  const countsByRef = new Map<string, number>()
  const needed = new Set<string>()
  for (const r of refRows) {
    const blockId = r.blockId
    const fileId = r.fileId
    if (typeof blockId !== 'string' || !isSafeFileId(fileId)) continue
    const list = refsByBlock.get(blockId) ?? []
    list.push(fileId)
    refsByBlock.set(blockId, list)
    const key = `${blockId}::${fileId}`
    const c = r.count
    countsByRef.set(key, typeof c === 'number' && Number.isSafeInteger(c) && c >= 0 ? c : 1)
    needed.add(fileId)
  }
  if (needed.size === 0) return empty
  // Same infra contract as the refs select above: throws propagate.
  const assetRows = dbTx
    .select({
      id: schema.syncFileAsset.id,
      byteLength: schema.syncFileAsset.byteLength,
      extension: schema.syncFileAsset.extension,
      originalName: schema.syncFileAsset.originalName,
      createdAt: schema.syncFileAsset.createdAt
    })
    .from(schema.syncFileAsset)
    .where(inArray(schema.syncFileAsset.id, [...needed]))
    .all()
  const assetsById = new Map<
    string,
    { byteLength: number; extension: string; originalName: string; createdAt: string }
  >()
  for (const a of assetRows) {
    if (!isSafeFileId(a.id)) continue
    const byteLength = a.byteLength
    const extension = normalizeExtension(a.extension)
    const originalName = a.originalName
    const createdAt = a.createdAt
    if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) continue
    if (extension === null) continue
    if (!isValidOriginalName(originalName)) continue
    if (typeof createdAt !== 'string' || createdAt.length === 0 || !Number.isFinite(Date.parse(createdAt))) {
      continue
    }
    assetsById.set(a.id, {
      byteLength,
      extension,
      originalName: originalName,
      createdAt: createdAt
    })
  }
  return { refsByBlock, countsByRef, assetsById }
}

/**
 * Hydrate `overflow.file` for portable media blocks missing it, using trusted
 * `file_references` + `sync_file_asset` rows inside the SAME read transaction.
 *
 * Mutates the supplied blocks in place (overflow only); never writes to SQLite.
 * Expected fail-safe (no refs/asset for a block, invalid stored ids/ext/names,
 * non-portable types, pre-existing overflow.file) preserves `null` and returns
 * normally. Real infra failures (files-dir unavailable, DB select throws, or an
 * unexpected per-block exception) THROW to the caller's `wrapResult` path,
 * which already logs sanitized (no content/path) via `errors.ts`; this helper
 * logs nothing and carries no path on the wire beyond the rebuilt local path.
 */
export function hydratePortableMediaFileOverflowInTx(tx: unknown, blocks: MessageBlockData[]): void {
  if (!Array.isArray(blocks) || blocks.length === 0) return
  const targets = blocks.filter((b) => isPortableMediaType(b?.type) && !hasExistingFileValue(b))
  if (targets.length === 0) return
  // Throws on infra (fail the read); never degraded to ok + null.
  const filesDir = resolveFilesDir()
  const blockIds = [...new Set(targets.map((b) => b.id).filter((id) => typeof id === 'string' && id.length > 0))]
  if (blockIds.length === 0) return
  // Throws on DB/infra; empty maps are the expected no-hydration fail-safe.
  const refs = readHydrateRefs(tx, blockIds)
  for (const block of targets) {
    // Explicit-validation fail-safe only: each invalid condition continues to
    // the next block without logging (no debug-then-continue observability
    // gap). Unexpected exceptions below (programming/infra) propagate.
    if (typeof block.id !== 'string' || block.id.length === 0) continue
    const fileIds = (refs.refsByBlock.get(block.id) ?? []).filter(isSafeFileId).sort()
    if (fileIds.length === 0) continue
    // Deterministic fail-closed: only the first sorted safe fileId is read.
    // When it has no valid asset the block stays null — never falls through
    // to a later valid asset (would mask the missing association).
    const fileId = fileIds[0]
    const asset = refs.assetsById.get(fileId)
    if (!asset) continue
    const storedName = `${fileId}${asset.extension}`
    const localPath = join(filesDir, storedName)
    const count = refs.countsByRef.get(`${block.id}::${fileId}`) ?? 1
    const fileDto: Record<string, unknown> = {
      id: fileId,
      name: storedName,
      origin_name: asset.originalName,
      path: localPath,
      size: asset.byteLength,
      ext: asset.extension,
      type: fileTypeForExtension(asset.extension),
      created_at: asset.createdAt,
      count: typeof count === 'number' ? count : 1
    }
    if (!block.overflow || typeof block.overflow !== 'object' || Array.isArray(block.overflow)) {
      block.overflow = {}
    }
    block.overflow.file = fileDto
    // Video blocks also group/render by top-level `filePath`: keep the
    // same local path there when absent so the existing video support
    // type observes the same local file without new coordination.
    if (typeof block.type === 'string' && block.type.toLowerCase() === 'video') {
      if (block.overflow.filePath === null || block.overflow.filePath === undefined) {
        block.overflow.filePath = localPath
      }
    }
  }
}

export type { TxLike }
