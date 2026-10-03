/**
 * Portable sync attachment metadata (JSON-only, no Node/Electron imports).
 *
 * New bounded unit: FileAsset + strict block file-reference projection.
 * Does NOT touch existing sync modules (types/payloadFilter/baselineWire/index
 * are owned elsewhere); import this module directly (`@shared/sync/attachments`).
 *
 * Wire rule: file paths are always localized and never synced. Only the
 * portable FileAsset below travels in operation payloads; the relay carries
 * raw bytes addressed by sha256. The Main transfer service resolves bytes
 * from the trusted local store and rebuilds local paths on install.
 */

/** Strict address form: lowercase hex SHA-256 (64 chars). Uppercase is rejected, never coerced. */
export const ATTACHMENT_DIGEST_RE = /^[0-9a-f]{64}$/

/** Block types whose canonical payload may be a portable file attachment. */
export const PORTABLE_SYNC_MEDIA_TYPES = ['file', 'image', 'video'] as const

export type PortableSyncMediaType = (typeof PORTABLE_SYNC_MEDIA_TYPES)[number]

const PORTABLE_MEDIA_SET: ReadonlySet<string> = new Set<string>([...PORTABLE_SYNC_MEDIA_TYPES])

/**
 * Portable file asset — exact schema. Exactly these 7 keys; no path, count,
 * tokens, purpose, device, or any other key is allowed on the wire.
 */
export interface FileAsset {
  /** Immutable file identity (local stored-file id, e.g. uuid without ext). */
  id: string
  /** Lowercase hex SHA-256 of the exact byte content. */
  sha256: string
  /** Exact byte length (non-negative safe integer). */
  byteLength: number
  /** File extension with leading dot, lowercase (e.g. `.pdf`). */
  extension: string
  /** MIME type (e.g. `image/png`). */
  mimeType: string
  /** Display basename only — never a path. */
  originalName: string
  /** ISO-8601 creation timestamp. */
  createdAt: string
}

export const FILE_ASSET_KEYS = [
  'id',
  'sha256',
  'byteLength',
  'extension',
  'mimeType',
  'originalName',
  'createdAt'
] as const

/** Keys that must never appear on a wire FileAsset (defense in depth). */
const DENIED_ASSET_KEYS: ReadonlySet<string> = new Set([
  'path',
  'filepath',
  'file_path',
  'count',
  'tokens',
  'purpose',
  'device',
  'deviceid',
  'devicecode',
  'devicesecret',
  'secret',
  'token',
  'credential',
  'password'
])

function isNonEmptyString(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen
}

function isValidAssetId(v: unknown): boolean {
  // Immutable local id: non-empty, bounded, never a path or traversal segment.
  if (!isNonEmptyString(v, 256)) return false
  const s = v
  if (s.includes('/') || s.includes('\\') || s.includes('..')) return false
  if (s.trim() !== s) return false
  return true
}

function isValidExtension(v: unknown): boolean {
  // Leading-dot lowercase extension, bounded charset.
  if (typeof v !== 'string') return false
  if (v.length < 2 || v.length > 16) return false
  if (!/^\.[a-z0-9]+$/.test(v)) return false
  return true
}

function isValidMimeType(v: unknown): boolean {
  if (typeof v !== 'string') return false
  if (v.length < 3 || v.length > 128) return false
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(v)) return false
  return true
}

function isValidOriginalName(v: unknown): boolean {
  // Display basename only — never a path.
  if (!isNonEmptyString(v, 255)) return false
  const s = v
  if (s.includes('/') || s.includes('\\')) return false
  if (s === '.' || s === '..') return false
  if (s.trim().length === 0) return false
  return true
}

function isValidCreatedAt(v: unknown): boolean {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) return false
  const t = Date.parse(v)
  if (!Number.isFinite(t)) return false
  return true
}

/**
 * Strict FileAsset validator. Returns an error string, or null when valid.
 * Exact schema: the 7 FileAsset keys only, no denied keys, hash/length coherent.
 */
export function validateFileAsset(asset: unknown): string | null {
  if (asset === null || asset === undefined || typeof asset !== 'object' || Array.isArray(asset)) {
    return 'asset must be an object'
  }
  const obj = asset as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length !== FILE_ASSET_KEYS.length) return 'asset must carry exactly the FileAsset keys'
  for (const k of FILE_ASSET_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return `asset missing key ${k}`
  }
  for (const k of keys) {
    if (DENIED_ASSET_KEYS.has(k.toLowerCase())) return `asset denied key ${k}`
  }
  if (!isValidAssetId(obj['id'])) return 'asset id invalid'
  if (typeof obj['sha256'] !== 'string' || !ATTACHMENT_DIGEST_RE.test(obj['sha256'])) {
    return 'asset sha256 invalid'
  }
  if (typeof obj['byteLength'] !== 'number' || !Number.isSafeInteger(obj['byteLength'])) {
    return 'asset byteLength invalid'
  }
  if (obj['byteLength'] < 0) return 'asset byteLength invalid'
  if (!isValidExtension(obj['extension'])) return 'asset extension invalid'
  if (!isValidMimeType(obj['mimeType'])) return 'asset mimeType invalid'
  if (!isValidOriginalName(obj['originalName'])) return 'asset originalName invalid'
  if (!isValidCreatedAt(obj['createdAt'])) return 'asset createdAt invalid'
  return null
}

/** True when the value is a strictly valid FileAsset. */
export function isFileAsset(value: unknown): value is FileAsset {
  return validateFileAsset(value) === null
}

/**
 * Minimal deterministic extension -> MIME derivation for portable assets.
 * Covers the syncable media surface; unknown extensions fall back to
 * `application/octet-stream` (truthful generic bytes, never a fake specific type).
 */
export function mimeTypeForExtension(extension: string): string {
  const ext = extension.toLowerCase()
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.bmp':
      return 'image/bmp'
    case '.svg':
      return 'image/svg+xml'
    case '.heic':
      return 'image/heic'
    case '.heif':
      return 'image/heif'
    case '.mp4':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    case '.mov':
      return 'video/quicktime'
    case '.mkv':
      return 'video/x-matroska'
    case '.avi':
      return 'video/x-msvideo'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.ogg':
      return 'audio/ogg'
    case '.m4a':
      return 'audio/mp4'
    case '.pdf':
      return 'application/pdf'
    case '.txt':
      return 'text/plain'
    case '.md':
    case '.markdown':
      return 'text/markdown'
    case '.json':
    case '.csv':
      return 'text/plain'
    default:
      if (ext.startsWith('.')) return 'application/octet-stream'
      return 'application/octet-stream'
  }
}

/**
 * Actual persisted file-reference shape (message_blocks companion rows):
 * companion `fileReferenceData` rows carry the file identity plus a metadata
 * snapshot in overflow (snake_case, mirroring FileMetadata). Only the fixed
 * fields below are read; any other overflow key is ignored (never trusted).
 */
export interface BlockFileReferenceInput {
  fileId?: unknown
  file_id?: unknown
  overflow?: Record<string, unknown> | null | undefined
}

/**
 * Actual block input for projection: committed block id/type plus its parsed
 * overflow and its companion file-reference rows.
 */
export interface PortableMediaBlockInput {
  id: unknown
  type: unknown
  overflow?: Record<string, unknown> | null | undefined
  fileRefs?: ReadonlyArray<BlockFileReferenceInput> | null | undefined
}

/** One portable attachment bound to its owning block. Asset id equals the file reference fileId. */
export interface FileAssetRef {
  blockId: string
  blockType: PortableSyncMediaType
  fileId: string
  asset: FileAsset
}

/**
 * Fixed-shape key allowlist for file-reference sources (the ref row object
 * plus its `overflow` metadata snapshot, which mirrors FileMetadata).
 * `READABLE` fields build the asset; `IGNORED_LOCAL` fields are local-only
 * (path/count/tokens/purpose/file-type markers) and never projected; the
 * `overflow` container key is descended into (its inner keys are checked the
 * same way). Any other key (tool/citation markers like `toolId`/`url`/
 * `response`, import-degraded markers, device/secret material, or any future
 * arbitrary overflow) rejects the whole ref — fixed shape, no arbitrary
 * overflow accepted.
 */
const REF_READABLE_KEYS: ReadonlySet<string> = new Set([
  'fileId',
  'file_id',
  'id',
  'sha256',
  'digest',
  'byteLength',
  'size',
  'extension',
  'ext',
  'mimeType',
  'mime',
  'originalName',
  'origin_name',
  'name',
  'fileName',
  'createdAt',
  'created_at'
])

const REF_IGNORED_LOCAL_KEYS: ReadonlySet<string> = new Set([
  'path',
  'file_path',
  'filePath',
  'count',
  'tokens',
  'purpose',
  'fileType',
  'type',
  'blockId',
  'block_id'
])

const REF_CONTAINER_KEYS: ReadonlySet<string> = new Set(['overflow'])

/**
 * Project the portable attachment refs for one block.
 *
 * - `tool`/`citation` (and any non file/image/video type) project to `[]`
 *   (remain excluded — the user only adds attachments in this unit).
 * - A file/image/video block MUST project every companion file reference to a
 *   strictly valid FileAsset; a block with zero refs or any ref that fails the
 *   fixed-shape strict check projects to `null` (unsupported full-state block —
 *   never a partial shell; the integrator keeps the existing unsupported gate
 *   and skips enqueue rather than syncing a part-shell).
 * - Only the fixed snapshot fields are read; local-only fields
 *   (path/count/tokens/purpose/file-type markers) are ignored, never
 *   projected; any other (arbitrary) key rejects the ref.
 */
export function projectPortableMediaRefs(block: PortableMediaBlockInput): FileAssetRef[] | null {
  if (!block || typeof block !== 'object') return []
  const rawType = typeof block.type === 'string' ? block.type.toLowerCase() : ''
  if (!PORTABLE_MEDIA_SET.has(rawType)) return []
  const blockType = rawType as PortableSyncMediaType
  if (typeof block.id !== 'string' || block.id.length === 0 || block.id.length > 256) return null
  const blockId = block.id
  const refs = block.fileRefs
  if (!Array.isArray(refs) || refs.length === 0) return null
  const out: FileAssetRef[] = []
  for (const ref of refs) {
    const asset = projectSingleFileRef(blockId, blockType, ref)
    if (!asset) return null
    out.push(asset)
  }
  return out
}

function readFirstString(sources: Array<Record<string, unknown>>, keys: string[], maxLen: number): string | null {
  for (const src of sources) {
    for (const k of keys) {
      const v = src[k]
      if (typeof v === 'string' && v.length > 0 && v.length <= maxLen) return v
    }
  }
  return null
}

function readByteLength(sources: Array<Record<string, unknown>>): number | null {
  for (const src of sources) {
    for (const k of ['byteLength', 'size']) {
      const v = src[k]
      if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v
    }
  }
  return null
}

function projectSingleFileRef(
  blockId: string,
  blockType: PortableSyncMediaType,
  ref: BlockFileReferenceInput | null | undefined
): FileAssetRef | null {
  if (!ref || typeof ref !== 'object') return null
  const refObj = ref as unknown as Record<string, unknown>
  const overflow =
    ref.overflow && typeof ref.overflow === 'object' && !Array.isArray(ref.overflow) ? ref.overflow : null
  const sources: Array<Record<string, unknown>> = overflow ? [refObj, overflow] : [refObj]

  // Fixed-shape gate: every key must be readable, known-local (ignored), or
  // the overflow container. Anything else (arbitrary overflow, tool/citation
  // markers, device/secret material) rejects the ref — never partially read.
  for (const src of sources) {
    for (const k of Object.keys(src)) {
      if (REF_READABLE_KEYS.has(k) || REF_IGNORED_LOCAL_KEYS.has(k) || REF_CONTAINER_KEYS.has(k)) continue
      return null
    }
  }

  const fileId = readFirstString(sources, ['fileId', 'file_id', 'id'], 256)
  if (!fileId || !isValidAssetId(fileId)) return null

  const sha256 = readFirstString(sources, ['sha256', 'digest'], 64)
  if (!sha256 || !ATTACHMENT_DIGEST_RE.test(sha256)) return null

  const byteLength = readByteLength(sources)
  if (byteLength === null) return null

  let extension = readFirstString(sources, ['extension', 'ext'], 16)
  if (!extension) return null
  extension = extension.toLowerCase()
  if (!extension.startsWith('.')) extension = `.${extension}`
  if (!isValidExtension(extension)) return null

  let mimeType = readFirstString(sources, ['mimeType', 'mime'], 128)
  if (mimeType !== null && !isValidMimeType(mimeType)) return null
  if (mimeType === null) mimeType = mimeTypeForExtension(extension)

  const originalName = readFirstString(sources, ['originalName', 'origin_name', 'name', 'fileName'], 255)
  if (!originalName || !isValidOriginalName(originalName)) return null

  const createdAt = readFirstString(sources, ['createdAt', 'created_at'], 64)
  if (!createdAt || !isValidCreatedAt(createdAt)) return null

  const asset: FileAsset = { id: fileId, sha256, byteLength, extension, mimeType, originalName, createdAt }
  if (validateFileAsset(asset) !== null) return null
  return { blockId, blockType, fileId, asset }
}
