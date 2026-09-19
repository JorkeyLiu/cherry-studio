import type { FileMetadata } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { audioExts, videoExts } from '@shared/config/constant'
import type { MediaAttachmentOpenRequest } from '@shared/mediaAttachment'

export type MediaKind = 'audio' | 'video' | 'other'

/**
 * Browser-decodable subset for the in-app HTML5 preview. Formats outside
 * these sets (e.g. `.avi`, `.wmv`, `.flv`, `.mkv`) are still sendable
 * attachments but render the generic media card with the default-app action.
 */
export const PLAYABLE_AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.webm'] as const

export const PLAYABLE_VIDEO_EXTS = ['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.m4v'] as const

const normalizeExt = (ext: string | null | undefined): string => (ext ?? '').toLowerCase()

/**
 * Media kind of an attachment. Prefers the typed `file.type` and falls back
 * to the extension so draft/legacy rows without a type still classify.
 */
export function getMediaKind(file: Pick<FileMetadata, 'type' | 'ext'>): MediaKind {
  if (file.type === FILE_TYPE.AUDIO) return 'audio'
  if (file.type === FILE_TYPE.VIDEO) return 'video'
  const ext = normalizeExt(file.ext)
  if (audioExts.includes(ext)) return 'audio'
  if (videoExts.includes(ext)) return 'video'
  return 'other'
}

/** Whether the attachment can be previewed with an in-app HTML5 player. */
export function isInAppPlayable(file: Pick<FileMetadata, 'type' | 'ext'>): boolean {
  const kind = getMediaKind(file)
  const ext = normalizeExt(file.ext)
  if (kind === 'audio') return (PLAYABLE_AUDIO_EXTS as readonly string[]).includes(ext)
  if (kind === 'video') return (PLAYABLE_VIDEO_EXTS as readonly string[]).includes(ext)
  return false
}

/**
 * Centralized `file://` URL builder for the in-app media preview.
 *
 * Returns `null` when there is no usable source path (missing, empty, or
 * non-string) so callers render the fallback card and never emit a broken
 * `file://` URL or reach IPC. Each path segment is percent-encoded so macOS
 * paths with spaces, `#`, `?` and similar characters produce a valid URL;
 * the drive-letter colon is preserved for Windows-style paths.
 */
export function toMediaFileUrl(fsPath: string | null | undefined): string | null {
  if (typeof fsPath !== 'string' || fsPath.length === 0) {
    return null
  }
  const normalized = fsPath.replace(/\\/g, '/')
  if (normalized.length === 0) {
    return null
  }
  const encoded = normalized
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':'))
    .join('/')
  return `file://${encoded}`
}

/**
 * Builds the narrow secure open request for "open with default app".
 *
 * - `stored` (sent attachments): addressed by `id + ext` only — the renderer
 *   never supplies a final resolved path on this branch.
 * - `external` (pre-upload drafts): addressed by the original path; Main only
 *   honors paths it previously registered via selectFile/getFile.
 *
 * Returns `null` when the file carries no usable identity for the scope, in
 * which case the caller must not offer (or must disable) the action and must
 * not reach IPC.
 */
export function buildMediaOpenRequest(
  file: Pick<FileMetadata, 'id' | 'ext' | 'path'>,
  scope: 'stored' | 'external'
): MediaAttachmentOpenRequest | null {
  if (scope === 'stored') {
    if (typeof file.id !== 'string' || file.id.length === 0) return null
    if (typeof file.ext !== 'string' || file.ext.length === 0) return null
    return { kind: 'stored', storedFileName: `${file.id}${file.ext}` }
  }
  if (typeof file.path !== 'string' || file.path.length === 0) return null
  return { kind: 'external', filePath: file.path }
}
