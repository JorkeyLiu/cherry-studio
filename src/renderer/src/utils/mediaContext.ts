/**
 * Media-context eligibility (single shared policy).
 *
 * The "media context" switch decides whether *historical* image/audio/video
 * attachments stay part of an outbound request. The switch is a
 * content-eligibility policy only: it never changes which turns make up the
 * context window, never edits a message, and never decides availability (a
 * present payload is omitted on purpose, which is not the same thing as a
 * missing payload).
 *
 * One predicate is shared by every consumer (request attachment view, token
 * estimation) so the payload a request carries and the payload the preview
 * counts can never drift apart.
 */
import { FILE_TYPE } from '@renderer/types/file'
import { MessageBlockType } from '@renderer/types/newMessage'

/**
 * Media attachment kinds covered by the switch: image blocks (including
 * url-only images without a local payload) and file attachments the app
 * classified as image/video/audio.
 *
 * Documents (PDF included), text files and every non-attachment block are
 * outside its scope and are never omitted.
 */
export function isMediaContextAttachmentBlock(block: {
  type?: string | null
  file?: { type?: string | null } | null
}): boolean {
  if (!block) return false
  if (block.type === MessageBlockType.IMAGE) return true
  if (block.type !== MessageBlockType.FILE) return false
  const fileType = block.file?.type
  return fileType === FILE_TYPE.IMAGE || fileType === FILE_TYPE.VIDEO || fileType === FILE_TYPE.AUDIO
}

/** Narrower form for a bare file row (used where no block is available). */
