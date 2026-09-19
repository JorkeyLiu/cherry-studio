/**
 * 消息转换模块
 * 将 Cherry Studio 消息格式转换为 AI SDK 消息格式
 */

import type { ReasoningPart } from '@ai-sdk/provider-utils'
import { loggerService } from '@logger'
import { isGenerateImageModel, isImageEnhancementModel } from '@renderer/config/models/vision'
import type { BlockOverlay } from '@renderer/services/requestBlockOverlay'
import { resolveOverlayBlock } from '@renderer/services/requestBlockOverlay'
import store from '@renderer/store'
import type { Message, Model } from '@renderer/types'
import type {
  FileMessageBlock,
  ImageMessageBlock,
  MainTextMessageBlock,
  MessageBlock,
  ThinkingMessageBlock
} from '@renderer/types/newMessage'
import {
  findFileBlocks,
  findImageBlocks,
  findMainTextBlocks,
  findThinkingBlocks,
  getMainTextContent
} from '@renderer/utils/messageUtils/find'
import { parseDataUrl } from '@shared/utils'
import type {
  AssistantModelMessage,
  FilePart,
  ImagePart,
  ModelMessage,
  SystemModelMessage,
  TextPart,
  UserModelMessage
} from 'ai'
import dayjs from 'dayjs'

import { attachmentEncodeUnsupportedError, attachmentFailedError, attachmentImageUrlError } from './attachmentErrors'
import { convertFileBlockToFilePart, convertFileBlockToTextPart } from './fileProcessor'

const logger = loggerService.withContext('messageConverter')

function overlayBlocksForMessage(message: Message, overlay?: BlockOverlay): MessageBlock[] | null {
  if (!overlay || !message.blocks || message.blocks.length === 0) return null
  const resolved: MessageBlock[] = []
  for (const id of message.blocks) {
    const b = resolveOverlayBlock(overlay, id)
    if (b) resolved.push(b)
  }
  return resolved.length > 0 && resolved.length === message.blocks.length
    ? resolved
    : resolved.length > 0
      ? resolved
      : null
}

function findBlocksWithOverlay<T>(
  message: Message,
  overlay: BlockOverlay | undefined,
  type: string,
  fallback: (m: Message) => T[]
): T[] {
  const over = overlayBlocksForMessage(message, overlay)
  if (over) {
    return (over as unknown as Array<{ type: string }>).filter((b) => b.type === type) as unknown as T[]
  }
  return fallback(message)
}

function mainTextContentWithOverlay(message: Message, overlay?: BlockOverlay): string {
  const over = overlayBlocksForMessage(message, overlay)
  if (over) {
    return (over as unknown as Array<{ type: string; content?: string }>)
      .filter((b) => b.type === 'main_text')
      .map((b) => b.content ?? '')
      .join('\n\n')
  }
  return getMainTextContent(message)
}

/**
 * 转换消息为 AI SDK 参数格式
 * 基于 OpenAI 格式的通用转换，支持文本、图片和文件
 */
export async function convertMessageToSdkParam(
  message: Message,
  isVisionModel = false,
  model?: Model,
  overlay?: BlockOverlay
): Promise<ModelMessage | ModelMessage[]> {
  let content = mainTextContentWithOverlay(message, overlay)

  // Inject context timestamp if enabled
  if (store.getState().settings.injectContextTimestamp && message.createdAt && message.role === 'user') {
    const timestamp = dayjs(message.createdAt).format('YYYY-MM-DD HH:mm:ss')
    content = `<message_time>${timestamp}</message_time>\n${content}`
  }

  const fileBlocks = findBlocksWithOverlay(message, overlay, 'file', findFileBlocks)
  const imageBlocks = findBlocksWithOverlay(message, overlay, 'image', findImageBlocks)
  const reasoningBlocks = findBlocksWithOverlay(message, overlay, 'thinking', findThinkingBlocks)
  const mainTextBlocks = findBlocksWithOverlay(message, overlay, 'main_text', findMainTextBlocks)
  if (message.role === 'user' || message.role === 'system') {
    return convertMessageToUserModelMessage(content, fileBlocks, imageBlocks, isVisionModel, model)
  } else {
    return convertMessageToAssistantModelMessage(
      content,
      fileBlocks,
      imageBlocks,
      reasoningBlocks,
      mainTextBlocks,
      model
    )
  }
}

async function convertImageBlockToImagePart(imageBlocks: ImageMessageBlock[]): Promise<Array<ImagePart>> {
  const parts: Array<ImagePart> = []
  for (const imageBlock of imageBlocks) {
    if (imageBlock.file) {
      try {
        const ext = imageBlock.file.ext.startsWith('.') ? imageBlock.file.ext : `.${imageBlock.file.ext}`
        const image = await window.api.file.base64Image(imageBlock.file.id + ext)
        if (!image?.base64 || !image?.mime || !image.mime.startsWith('image/')) {
          throw new Error(`unreliable image payload (mime "${image?.mime}")`)
        }
        parts.push({
          type: 'image',
          image: image.base64,
          mediaType: image.mime
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw attachmentFailedError(imageBlock.file.origin_name, 'image', reason)
      }
    } else if (imageBlock.url) {
      const url = imageBlock.url
      const parseResult = parseDataUrl(url)
      if (parseResult?.isBase64) {
        const { mediaType, data } = parseResult
        if (!data) {
          throw attachmentImageUrlError('empty base64 payload')
        }
        parts.push({ type: 'image', image: data, ...(mediaType ? { mediaType } : {}) })
      } else if (url.startsWith('data:')) {
        throw attachmentImageUrlError('malformed or non-base64 data URL')
      } else {
        // For remote URLs we keep payload minimal to match existing expectations.
        parts.push({ type: 'image', image: url })
      }
    }
  }
  return parts
}

/**
 * 转换为用户模型消息
 */
async function convertMessageToUserModelMessage(
  content: string,
  fileBlocks: FileMessageBlock[],
  imageBlocks: ImageMessageBlock[],
  _isVisionModel = false,
  model?: Model
): Promise<UserModelMessage | (UserModelMessage | SystemModelMessage)[]> {
  const parts: Array<TextPart | FilePart | ImagePart> = []
  if (content) {
    parts.push({ type: 'text', text: content })
  }

  // Unit B: ordinary chat is user-intent driven. Images are always encoded when
  // the endpoint/SDK can carry them; model vision metadata never gates sending.
  // Read/encode failures abort via convertImageBlockToImagePart (never omitted).
  parts.push(...(await convertImageBlockToImagePart(imageBlocks)))
  // 处理文件（原子性：任何附件失败中止请求，绝不省略后发纯文本）
  for (const fileBlock of fileBlocks) {
    const file = fileBlock.file
    let processed = false

    // 优先尝试原生文件支持（PDF、图片/音频/视频等）
    if (model) {
      const filePart = await convertFileBlockToFilePart(fileBlock, model)
      if (filePart) {
        // 判断filePart是否为string
        if (typeof filePart.data === 'string' && filePart.data.startsWith('fileid://')) {
          return [
            {
              role: 'system',
              content: filePart.data
            },
            {
              role: 'user',
              content: parts.length > 0 ? parts : ''
            }
          ]
        }
        parts.push(filePart)
        logger.debug(`File ${file.origin_name} processed as native file format`)
        processed = true
      }
    }

    // 如果原生处理不适用，回退到文本提取；两者皆无则明确失败
    if (!processed) {
      const textPart = await convertFileBlockToTextPart(fileBlock)
      if (textPart) {
        parts.push(textPart)
        logger.debug(`File ${file.origin_name} processed as text content`)
      } else {
        throw attachmentEncodeUnsupportedError(file.origin_name, file.type ?? 'unknown type')
      }
    }
  }

  return {
    role: 'user',
    content: parts
  }
}

/**
 * Replaces markdown images with data URI sources (e.g. `![alt](data:image/...;base64,...)`)
 * with a placeholder `![alt](image)` to avoid sending huge base64 payloads to the API.
 *
 * Uses string scanning (indexOf) instead of regex to avoid OOM on multi-MB base64 strings.
 */
export function stripMarkdownBase64Images(text: string): string {
  const marker = '](data:'
  let result = ''
  let searchFrom = 0

  while (searchFrom < text.length) {
    const markerIdx = text.indexOf(marker, searchFrom)
    if (markerIdx === -1) {
      result += text.slice(searchFrom)
      break
    }

    // Find the `![` that starts this markdown image — walk backwards from `](`
    const bangIdx = text.lastIndexOf('![', markerIdx)
    if (bangIdx === -1 || text.indexOf(']', bangIdx + 2) !== markerIdx) {
      // Not a valid markdown image — skip past this marker
      result += text.slice(searchFrom, markerIdx + marker.length)
      searchFrom = markerIdx + marker.length
      continue
    }

    // Find the closing `)` — the URL part starts after `](`
    const urlStart = markerIdx + 2 // position right after `](`
    const closeIdx = text.indexOf(')', urlStart)
    if (closeIdx === -1) {
      result += text.slice(searchFrom)
      break
    }

    // Extract alt text between `![` and `]`
    const altText = text.slice(bangIdx + 2, markerIdx)

    // Append everything before `![` plus the replacement
    result += text.slice(searchFrom, bangIdx) + `![${altText}](image)`
    searchFrom = closeIdx + 1
  }

  return result
}

/**
 * 转换为助手模型消息
 * 注意：当助手消息只包含图片（如图片生成模型的响应）而没有文本时，
 * 需要添加占位文本，因为某些 API（如 Gemini）不接受空的 assistant 消息
 */
async function convertMessageToAssistantModelMessage(
  content: string,
  fileBlocks: FileMessageBlock[],
  imageBlocks: ImageMessageBlock[],
  thinkingBlocks: ThinkingMessageBlock[],
  mainTextBlocks: MainTextMessageBlock[],
  model?: Model
): Promise<AssistantModelMessage> {
  const parts: Array<TextPart | ReasoningPart | FilePart> = []

  // Add reasoning blocks first (required by AWS Bedrock for Claude extended thinking)
  for (const thinkingBlock of thinkingBlocks) {
    parts.push({ type: 'reasoning', text: thinkingBlock.content })
  }

  // Add text content after reasoning blocks, only if non-empty after trimming
  // Also add thoughtSignature from MainTextBlock metadata for Gemini thought signature persistence
  // Strip inline base64 data URIs from markdown images to prevent HTTP 413 errors (#12602)
  // Uses string scanning instead of regex to avoid OOM on large base64 payloads
  const trimmedContent = stripMarkdownBase64Images(content?.trim() ?? '')
  if (trimmedContent) {
    // Find the first MainTextBlock with thoughtSignature
    const thoughtSignature = mainTextBlocks.find((block) => block.metadata?.thoughtSignature)?.metadata
      ?.thoughtSignature

    const textPart: TextPart = { type: 'text', text: trimmedContent }

    // Add providerOptions with thoughtSignature if available (for Gemini)
    if (thoughtSignature) {
      textPart.providerOptions = {
        google: {
          thoughtSignature
        }
      }
    }

    parts.push(textPart)
  }

  for (const fileBlock of fileBlocks) {
    // 优先尝试原生文件支持（PDF等）；失败时中止而非静默省略
    if (model) {
      const filePart = await convertFileBlockToFilePart(fileBlock, model)
      if (filePart) {
        parts.push(filePart)
        continue
      }
    }

    // 回退到文本处理；两者皆无则明确失败
    const textPart = await convertFileBlockToTextPart(fileBlock)
    if (textPart) {
      parts.push(textPart)
    } else {
      const file = fileBlock.file
      throw attachmentEncodeUnsupportedError(file.origin_name, file.type ?? 'unknown type')
    }
  }

  // 当 parts 为空但有图片时，添加占位文本
  // 这对于图片生成模型的继续对话很重要，因为助手消息可能只包含生成的图片
  if (parts.length === 0 && imageBlocks.length > 0) {
    parts.push({ type: 'text', text: '[Image]' })
  }

  return {
    role: 'assistant',
    content: parts
  }
}

/**
 * Converts an array of messages to SDK-compatible model messages.
 *
 * Unit B: every ordinary-chat message carries its own images (no vision
 * metadata gate). History image merging is preserved ONLY for the dedicated
 * image-editing path (enhancement / generate-image models), never as a
 * vision authorization.
 */
export async function convertMessagesToSdkMessages(
  messages: Message[],
  model: Model,
  overlay?: BlockOverlay
): Promise<ModelMessage[]> {
  const sdkMessages: ModelMessage[] = []
  // `isVisionModel` is kept only as a legacy call signature slot; sending no
  // longer depends on it. Pass `true` so per-message conversion always encodes
  // images when the endpoint/SDK can carry them.
  for (const message of messages) {
    const sdkMessage = await convertMessageToSdkParam(message, true, model, overlay)
    sdkMessages.push(...(Array.isArray(sdkMessage) ? sdkMessage : [sdkMessage]))
  }
  // History image merge stays scoped to the dedicated image-editing path.
  const needsHistoryImageMerge = isImageEnhancementModel(model) || isGenerateImageModel(model)
  if (needsHistoryImageMerge) {
    // Find the last user SDK message index
    const lastUserSdkIndex = (() => {
      for (let i = sdkMessages.length - 1; i >= 0; i--) {
        if (sdkMessages[i].role === 'user') return i
      }
      return -1
    })()

    // If no user message found, return messages as-is
    if (lastUserSdkIndex < 0) {
      return sdkMessages
    }

    // Find the nearest preceding assistant message in original messages
    let prevAssistant: Message | null = null
    for (let i = messages.length - 2; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        prevAssistant = messages[i]
        break
      }
    }

    // Check if there are images from the previous assistant message
    const imageBlocks = prevAssistant ? findBlocksWithOverlay(prevAssistant, overlay, 'image', findImageBlocks) : []
    const imageParts = await convertImageBlockToImagePart(imageBlocks)

    // If no images to merge, return messages as-is
    if (imageParts.length === 0) {
      return sdkMessages
    }

    // Build the new last user message with merged images
    const lastUserSdk = sdkMessages[lastUserSdkIndex] as UserModelMessage
    let finalUserParts: Array<TextPart | FilePart | ImagePart> = []

    if (typeof lastUserSdk.content === 'string') {
      finalUserParts.push({ type: 'text', text: lastUserSdk.content })
    } else if (Array.isArray(lastUserSdk.content)) {
      finalUserParts = [...lastUserSdk.content]
    }

    // Append images from the previous assistant message
    finalUserParts.push(...imageParts)

    // Replace the last user message with the merged version
    const result = [...sdkMessages]
    result[lastUserSdkIndex] = { role: 'user', content: finalUserParts }

    return result
  }

  return sdkMessages
}
