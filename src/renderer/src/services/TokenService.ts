import type { Assistant, FileMetadata, Usage } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { findFileBlocks, getMainTextContent, getThinkingContent } from '@renderer/utils/messageUtils/find'
import { approximateTokenSize } from 'tokenx'

/**
 * 估算文本内容的 token 数量
 *
 * @param text - 需要估算的文本内容
 * @returns 返回估算的 token 数量
 */
export function estimateTextTokens(text: string) {
  return approximateTokenSize(text)
}

/**
 * Combines history-context token count with draft token count for display.
 *
 * LOCK-001: Displayed token scalar = historyTokenCount + draftTokenCount
 * LOCK-002: One scalar render; no x/y.
 *
 * @param historyTokenCount - Token count from conversation history events
 * @param draftTokenCount   - Estimated token count of current input draft
 * @returns Combined scalar token estimate
 */
export function combineHistoryAndDraftTokens(historyTokenCount: number, draftTokenCount: number): number {
  return historyTokenCount + draftTokenCount
}

/**
 * 估算图片文件的 token 数量
 *
 * 根据图片文件大小计算预估的 token 数量。
 * 当前使用简单的文件大小除以 100 的方式进行估算。
 *
 * @param file - 图片文件对象
 * @returns 返回估算的 token 数量
 */
export function estimateImageTokens(file: FileMetadata) {
  return Math.floor(file.size / 100)
}

/**
 * 估算用户输入内容（文本和文件）的 token 用量。
 *
 * 该函数只根据传入的 content（文本内容）和 files（文件列表）估算，
 * 不依赖完整的 Message 结构，也不会处理消息块、上下文等信息。
 *
 * @param {Object} params - 输入参数对象
 * @param {string} [params.content] - 用户输入的文本内容
 * @param {FileMetadata[]} [params.files] - 用户上传的文件列表（支持图片和文本）
 * @returns {Promise<Usage>} 返回一个 Usage 对象，包含 prompt_tokens、completion_tokens、total_tokens
 */
export async function estimateUserPromptUsage({
  content,
  files
}: {
  content?: string
  files?: FileMetadata[]
}): Promise<Usage> {
  let imageTokens = 0

  if (files && files.length > 0) {
    const images = files.filter((f) => f.type === FILE_TYPE.IMAGE)
    if (images.length > 0) {
      for (const image of images) {
        imageTokens = estimateImageTokens(image) + imageTokens
      }
    }
  }

  const tokens = estimateTextTokens(content || '')

  return {
    prompt_tokens: tokens,
    completion_tokens: tokens,
    total_tokens: tokens + (imageTokens ? imageTokens - 7 : 0)
  }
}

/**
 * 估算完整消息（Message）的 token 用量。
 *
 * 该函数会自动从 message 中提取主文本内容、推理内容（reasoningContent）和所有文件块，
 * 统计文本和图片的 token 数量，适用于对完整消息对象进行 usage 估算。
 *
 * @param {Partial<Message>} message - 消息对象，可以是完整或部分 Message
 * @returns {Promise<Usage>} 返回一个 Usage 对象，包含 prompt_tokens、completion_tokens、total_tokens
 */
export async function estimateMessageUsage(message: Partial<Message>): Promise<Usage> {
  const fileBlocks = findFileBlocks(message as Message)
  const files = fileBlocks.map((f) => f.file)

  let imageTokens = 0

  if (files.length > 0) {
    const images = files.filter((f) => f.type === FILE_TYPE.IMAGE)
    if (images.length > 0) {
      for (const image of images) {
        imageTokens = estimateImageTokens(image) + imageTokens
      }
    }
  }

  const content = getMainTextContent(message as Message)
  const reasoningContent = getThinkingContent(message as Message)
  const combinedContent = [content, reasoningContent].filter((s) => s !== undefined).join(' ')
  const tokens = estimateTextTokens(combinedContent)

  return {
    prompt_tokens: tokens,
    completion_tokens: tokens,
    total_tokens: tokens + (imageTokens ? imageTokens - 7 : 0)
  }
}

export async function estimateMessagesUsage({
  assistant,
  messages
}: {
  assistant: Assistant
  messages: Message[]
}): Promise<Usage> {
  const outputMessage = messages.pop()!

  const prompt_tokens = await estimateHistoryTokens(assistant, messages)
  const { completion_tokens } = await estimateMessageUsage(outputMessage)

  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens
  } as Usage
}

/**
 * Estimate token count for the conversation history.
 *
 * Accepts already-filtered messages (the canonical `tokenEstimationMessages`
 * from `computeContextInfo` or `uiMessages` from callers that don't need
 * trailing-assistant retention) — callers are responsible for context-window
 * selection, turn grouping, and model-filter passes. This function
 * does NOT re-window or re-filter; it estimates tokens over the
 * exact message set it receives.
 *
 * LOCK-003: Content-based estimation. Every message is estimated from its
 * content blocks (text + reasoning + files), not from historical usage fields.
 * The assistant system prompt is added once. This ensures that two different
 * context windows with the same latest assistant but different selected earlier
 * turns yield different estimates.
 *
 * @param assistant - Used for the system prompt token estimate.
 * @param messages  - Pre-filtered message list.
 */
export async function estimateHistoryTokens(assistant: Assistant, messages: Message[]): Promise<number> {
  let totalTokens = 0

  // Estimate each message from content (text + reasoning + files).
  for (const message of messages) {
    const usage = await estimateMessageUsage(message)
    totalTokens += usage.total_tokens
  }

  // Add system prompt tokens.
  totalTokens += estimateTextTokens(assistant.prompt || '')

  return totalTokens
}
