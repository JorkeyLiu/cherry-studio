import { loggerService } from '@logger'
import { isStoredFile } from '@renderer/aiCore/prepareParams/sendableFileText'
import i18n from '@renderer/i18n'
import type { BlockOverlay } from '@renderer/services/requestBlockOverlay'
import { resolveOverlayBlock } from '@renderer/services/requestBlockOverlay'
import store from '@renderer/store'
import { messageBlocksSelectors } from '@renderer/store/messageBlock'
import type { FileMetadata } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'
import { isBlockAttachmentUnavailable } from '@renderer/utils/attachmentAvailability'
import { isMediaContextAttachmentBlock } from '@renderer/utils/mediaContext'

const logger = loggerService.withContext('requestAttachmentAvailability')

/**
 * Request-local attachment availability for one outbound conversion.
 *
 * An imported/history message may reference attachments whose payload does not
 * exist on this device (import without payload bytes, file removed outside the
 * app). Such a reference must not abort an otherwise sendable request: the
 * attachment is excluded from THIS request only, while the surrounding text and
 * every usable attachment keep flowing. Nothing is deleted, repaired, or
 * persisted — the view lives exactly as long as the conversion consuming it.
 *
 * Classification per attachment block:
 * - import availability marker (`l2AttachmentUnavailable === true`) → unavailable,
 *   decided from the block itself with no filesystem probe.
 * - managed stored payload (`id + ext` under the storage directory) probed with
 *   the narrow `file.exists` capability → unavailable when absent.
 * - image whose local payload is absent but that still carries usable `url`
 *   content (data URL / remote) → keeps that content instead of being dropped.
 * - anything not provably missing (pre-upload draft path, no probe capability,
 *   probe failure) stays in the request, so genuine read/encode/oversize/
 *   permission failures keep aborting through the existing attachment errors.
 */
export interface RequestAttachmentFilter {
  /**
   * Attachment blocks excluded from this request. Two distinct reasons land
   * here, and both mean exactly "never encode this block for this request":
   * the payload is provably unavailable on this device, or the block is a
   * historical media payload deliberately omitted by the media-context switch.
   */
  readonly unavailableBlockIds: ReadonlySet<string>
  /** Image blocks kept via their `url` because the local payload is absent. */
  readonly urlFallbackBlockIds: ReadonlySet<string>
}

export interface RequestAttachmentAvailability {
  /** Messages with attachments that have no content left for the request removed. */
  messages: Message[]
  filter: RequestAttachmentFilter
  /** Unavailable attachments of the triggering message (toast/error scope). */
  triggerUnavailableAttachmentCount: number
  /** False when the triggering message has nothing sendable left. */
  triggerHasSendableContent: boolean
}

type PayloadProbe = 'available' | 'unavailable' | 'unknown'
type BlockAvailability = 'usable' | 'url-fallback' | 'unavailable' | 'omitted'

function fileExistsCapability(): ((storedFileName: string) => Promise<boolean>) | undefined {
  // Accessed through a narrow cast: the capability is optional at runtime (older
  // preload surfaces, unit-test environments) and its absence must never be read
  // as "the file is missing".
  const api = (window as unknown as { api?: { file?: { exists?: (storedFileName: string) => Promise<boolean> } } }).api
  return api?.file?.exists
}

/**
 * Probe the managed payload for one attachment's stored file name.
 *
 * The probed name is the same `id + ext` identity the conversion readers use, so
 * a stale `path` (e.g. an import-time absolute path from another machine) never
 * decides availability.
 */
async function probeStoredPayload(file: FileMetadata | undefined): Promise<PayloadProbe> {
  if (!file || typeof file.id !== 'string' || file.id.length === 0) return 'unknown'
  if (typeof file.ext !== 'string') return 'unknown'
  // Only managed stored files have a probe target; a pre-upload draft's storage
  // copy legitimately does not exist yet, so it is never classified as missing.
  if (!isStoredFile(file)) return 'unknown'
  const exists = fileExistsCapability()
  if (!exists) return 'unknown'
  try {
    return (await exists(`${file.id}${file.ext}`)) ? 'available' : 'unavailable'
  } catch (error) {
    // A failed probe is not evidence of a missing payload: keep the attachment
    // and let the existing read/encode path decide (never silently drop).
    logger.warn('attachment availability probe failed; keeping the attachment', error as Error)
    return 'unknown'
  }
}

async function classifyAttachmentBlock(block: MessageBlock): Promise<BlockAvailability | null> {
  if (block.type === MessageBlockType.IMAGE) {
    if (isBlockAttachmentUnavailable(block)) return 'unavailable'
    if (!block.file) return null
    if ((await probeStoredPayload(block.file)) !== 'unavailable') return 'usable'
    return typeof block.url === 'string' && block.url.length > 0 ? 'url-fallback' : 'unavailable'
  }
  if (block.type === MessageBlockType.FILE) {
    if (isBlockAttachmentUnavailable(block)) return 'unavailable'
    if (!block.file) return null
    return (await probeStoredPayload(block.file)) === 'unavailable' ? 'unavailable' : 'usable'
  }
  return null
}

function resolveBlock(blockId: string, overlay?: BlockOverlay): MessageBlock | undefined {
  return resolveOverlayBlock(overlay, blockId) ?? messageBlocksSelectors.selectById(store.getState(), blockId)
}

interface MessageClassification {
  message: Message
  /** Blocks excluded from this request (missing payload or deliberate omission). */
  excludedBlockIds: string[]
  urlFallbackBlockIds: string[]
  /** False only when this message provably has nothing left to send. */
  hasSendableContent: boolean
}

function hasNonEmptyText(block: MessageBlock): boolean {
  if (block.type !== MessageBlockType.MAIN_TEXT) return false
  const content = (block as { content?: unknown }).content
  return typeof content === 'string' && content.trim().length > 0
}

/**
 * Global media-context switch, read once per request.
 *
 * A missing persisted key means ON (the feature default), so an older persisted
 * settings object — or a settings slice synced from a window that predates the
 * field — keeps the existing behavior instead of silently dropping history
 * media.
 */
function isHistoryMediaContextEnabled(): boolean {
  const settings = store.getState().settings as { includeHistoryMediaContext?: boolean } | undefined
  return settings?.includeHistoryMediaContext !== false
}

async function classifyMessage(
  message: Message,
  overlay?: BlockOverlay,
  omitMediaBlocks = false
): Promise<MessageClassification> {
  const blockIds = Array.isArray(message.blocks) ? message.blocks : []
  const resolved = blockIds.map((blockId) => resolveBlock(blockId, overlay))

  // Unresolvable block references (or a message whose blocks are not in the
  // request view at all) make the message unclassifiable: keep it in the
  // request unchanged and let the existing conversion decide.
  if (blockIds.length === 0 || resolved.some((block) => !block)) {
    return { message, excludedBlockIds: [], urlFallbackBlockIds: [], hasSendableContent: true }
  }
  return classifyResolvedBlocks(message, resolved as MessageBlock[], omitMediaBlocks)
}

/**
 * Availability of a message whose blocks are already fully resolved.
 *
 * Split from the overlay lookup so the pre-request entry gate can classify a
 * message from explicitly supplied blocks only — never reading Redux as a
 * fallback for references it was not given.
 *
 * `omitMediaBlocks` is the media-context switch applied to THIS message: its
 * image/audio/video attachments are excluded before any payload probe, so a
 * deliberate omission never costs IO and can never be reported as a missing
 * file.
 */
async function classifyResolvedBlocks(
  message: Message,
  blocks: MessageBlock[],
  omitMediaBlocks = false
): Promise<MessageClassification> {
  const availabilities = await Promise.all(
    blocks.map(async (block): Promise<BlockAvailability | null> => {
      if (omitMediaBlocks && isMediaContextAttachmentBlock(block)) return 'omitted'
      return classifyAttachmentBlock(block)
    })
  )

  const excludedBlockIds: string[] = []
  const urlFallbackBlockIds: string[] = []
  let hasUsableAttachment = false
  let hasOtherContent = false

  blocks.forEach((block, index) => {
    const availability = availabilities[index]
    if (availability === 'unavailable' || availability === 'omitted') {
      excludedBlockIds.push(block.id)
      return
    }
    if (availability === 'url-fallback') {
      urlFallbackBlockIds.push(block.id)
      hasUsableAttachment = true
      return
    }
    if (availability === 'usable') {
      hasUsableAttachment = true
      return
    }
    if (hasNonEmptyText(block)) {
      hasOtherContent = true
      return
    }
    // Any non-attachment, non-text block (thinking/code/tool/citation/…) is
    // treated as content: pruning is reserved for messages that provably lost
    // all of their sendable material.
    if (block.type !== MessageBlockType.MAIN_TEXT) hasOtherContent = true
  })

  return {
    message,
    excludedBlockIds,
    urlFallbackBlockIds,
    hasSendableContent: hasOtherContent || hasUsableAttachment
  }
}

/**
 * Resolve the request-local attachment availability of one outbound conversion.
 *
 * Media-context switch: when OFF, image/audio/video attachments of every
 * message except the triggering one are omitted from this request. The switch
 * is request-local — nothing is deleted, rewritten, or persisted, so turning it
 * ON again restores the exact same history payloads.
 *
 * @param messages  The bounded request view (trigger inclusive).
 * @param overlay   The request-local block overlay the conversion will read.
 * @param triggerId Stable ID of the triggering user message; it scopes the
 *                  unavailable-attachment notice AND is the media-context
 *                  boundary, because the triggering turn's media is part of the
 *                  current request rather than of history.
 */
export async function resolveRequestAttachmentAvailability(
  messages: Message[],
  overlay?: BlockOverlay,
  triggerId?: string
): Promise<RequestAttachmentAvailability> {
  // Without a stable trigger identity there is no history boundary to apply, so
  // the switch is never applied blindly.
  const excludeHistoryMedia = !isHistoryMediaContextEnabled() && triggerId !== undefined
  const classifications = await Promise.all(
    messages.map((message) => classifyMessage(message, overlay, excludeHistoryMedia && message.id !== triggerId))
  )

  const unavailableBlockIds = new Set<string>()
  const urlFallbackBlockIds = new Set<string>()
  const requestMessages: Message[] = []
  let triggerUnavailableAttachmentCount = 0
  let triggerHasSendableContent = true
  let triggerFound = false

  for (const classification of classifications) {
    for (const blockId of classification.excludedBlockIds) unavailableBlockIds.add(blockId)
    for (const blockId of classification.urlFallbackBlockIds) urlFallbackBlockIds.add(blockId)
    // A history message whose attachments are all unavailable or deliberately
    // omitted, and that carries no sendable content of its own, is dropped from
    // the request instead of becoming an empty wire message.
    if (classification.hasSendableContent || classification.excludedBlockIds.length === 0) {
      requestMessages.push(classification.message)
    }
    if (triggerId && classification.message.id === triggerId) {
      triggerFound = true
      triggerUnavailableAttachmentCount = classification.excludedBlockIds.length
      triggerHasSendableContent = classification.hasSendableContent
    }
  }

  return {
    messages: requestMessages,
    filter: { unavailableBlockIds, urlFallbackBlockIds },
    triggerUnavailableAttachmentCount,
    triggerHasSendableContent: triggerFound ? triggerHasSendableContent : true
  }
}

/**
 * Attachment availability of ONE triggering message, resolved from explicit
 * blocks before any request exists.
 *
 * The send/resend/regenerate entry points use this to decide whether the
 * operation has anything to send at all, so an all-unavailable message ends
 * before an assistant row, a provider request, or an error block exists. Block
 * references that do not resolve (window-outside message) leave the message
 * unclassifiable — `hasSendableContent` stays true and the caller proceeds
 * exactly as before.
 */
export async function resolveTriggerAttachmentAvailability(
  message: Message,
  blocks: MessageBlock[]
): Promise<{ unavailableAttachmentCount: number; hasSendableContent: boolean }> {
  const byId = new Map<string, MessageBlock>()
  for (const block of blocks) {
    if (block && typeof block.id === 'string' && block.id.length > 0) byId.set(block.id, block)
  }
  const blockIds = Array.isArray(message.blocks) ? message.blocks : []
  const resolved = blockIds.map((blockId) => byId.get(blockId))
  // Explicit-block resolution only: a reference the caller did not supply
  // (window-outside projection) is never looked up in Redux here. Unclassifiable
  // means "proceed", never "skip".
  if (blockIds.length === 0 || resolved.some((block) => !block)) {
    return { unavailableAttachmentCount: 0, hasSendableContent: true }
  }
  const classification = await classifyResolvedBlocks(message, resolved as MessageBlock[])
  return {
    unavailableAttachmentCount: classification.excludedBlockIds.length,
    hasSendableContent: classification.hasSendableContent
  }
}

/**
 * Top-of-interface notification for the triggering message's unavailable
 * attachments: one aggregated toast per request, never one per attachment and
 * never for history references.
 */
export function notifyUnavailableAttachmentsSkipped(count: number): void {
  if (count <= 0) return
  const toast = (window as unknown as { toast?: { error?: (content: string) => void } }).toast
  if (typeof toast?.error !== 'function') return
  toast.error(i18n.t('message.error.attachment.unavailable_skipped', { count }) as unknown as string)
}
