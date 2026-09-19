import { audioExts, videoExts } from './config/constant'

/**
 * Narrow media-attachment open request for the in-app audio/video preview.
 *
 * The renderer must never hand Main a final arbitrary resolved path for a
 * stored (managed) attachment. Stored files are addressed by `id + ext` only
 * and resolved inside `storageDir` by the production `validateStoredFilePath`
 * helper. Pre-upload external files are addressed by their original path but
 * are only honored when the current Main process previously returned that
 * path from `FileStorage.selectFile` / `FileStorage.getFile` (drag-drop) and
 * registered it in the in-memory allow-set.
 */
export type MediaAttachmentOpenRequest =
  | {
      kind: 'stored'
      /** Stored file name (`id + ext`), resolved inside storageDir by Main. */
      storedFileName: string
    }
  | {
      kind: 'external'
      /** Original absolute path of a pre-upload draft file. */
      filePath: string
    }

export function isMediaAttachmentOpenRequest(value: unknown): value is MediaAttachmentOpenRequest {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  if (record.kind === 'stored') {
    return typeof record.storedFileName === 'string' && record.storedFileName.length > 0
  }
  if (record.kind === 'external') {
    return typeof record.filePath === 'string' && record.filePath.length > 0
  }
  return false
}

/**
 * Narrow allow-set for the pre-upload external media path registry and the
 * `openMediaAttachment` external branch (F1).
 *
 * Single source of truth built from the currently supported sendable
 * audio/video attachment extensions (`audioExts` + `videoExts`, which already
 * cover both in-app playable and fallback-preview/system-open containers).
 * Non-media extensions are never allowed here. Main and tests must reuse
 * these helpers instead of maintaining a second list.
 */
const supportedExternalMediaExts = new Set<string>([...audioExts, ...videoExts].map((ext) => ext.toLowerCase()))

/**
 * Normalizes an extension for the external media allow-set: lowercases and
 * ensures a leading dot (`mp3` → `.mp3`, `.MP3` → `.mp3`).
 */
export function normalizeMediaAttachmentExt(ext: unknown): string {
  if (typeof ext !== 'string') {
    return ''
  }
  const lowered = ext.toLowerCase()
  if (lowered.length === 0) {
    return ''
  }
  return lowered.startsWith('.') ? lowered : `.${lowered}`
}

/** Whether an extension belongs to the supported external audio/video set. */
export function isSupportedMediaAttachmentExt(ext: unknown): boolean {
  const normalized = normalizeMediaAttachmentExt(ext)
  if (normalized.length === 0) {
    return false
  }
  return supportedExternalMediaExts.has(normalized)
}
