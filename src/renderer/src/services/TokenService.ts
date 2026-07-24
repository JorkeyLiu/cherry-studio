import type { Assistant, FileMetadata, Usage } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'

import { estimateDraftTokens, estimateMessageTokens, estimateTextTokens } from './LocalTokenEstimator'

// 统一估算器入口（LOCK-005：草稿与历史共用同一估算器）
export { estimateTextTokens }

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
 * 估算用户输入内容（文本和文件）的 token 用量。
 *
 * 该函数只根据传入的 content（文本内容）和 files（文件列表）估算，
 * 不依赖完整的 Message 结构，也不会处理消息块、上下文等信息。
 * 附件估算统一走 LocalTokenEstimator（文本/代码/Office 复用实际发送文本，
 * 图片按分辨率估算，PDF 分层估算）。
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
  const estimate = await estimateDraftTokens({ content, files })

  return {
    prompt_tokens: estimate.textTokens,
    completion_tokens: estimate.textTokens,
    total_tokens: estimate.totalTokens
  }
}

/**
 * 估算完整消息（Message）的 token 用量。
 *
 * 该函数会自动从 message 中提取主文本内容、推理内容（reasoningContent）、
 * 所有文件块（FileMessageBlock）与图片块（ImageMessageBlock），
 * 统一通过 LocalTokenEstimator 统计文本与附件的 token 数量。
 *
 * @param {Partial<Message>} message - 消息对象，可以是完整或部分 Message
 * @returns {Promise<Usage>} 返回一个 Usage 对象，包含 prompt_tokens、completion_tokens、total_tokens
 */
export async function estimateMessageUsage(message: Partial<Message>): Promise<Usage> {
  const estimate = await estimateMessageTokens(message as Message)

  return {
    prompt_tokens: estimate.textTokens,
    completion_tokens: estimate.textTokens,
    total_tokens: estimate.totalTokens
  }
}

export async function estimateMessagesUsage({
  assistant,
  messages
}: {
  assistant: Assistant
  messages: Message[]
}): Promise<Usage> {
  // Non-mutating split: the last message is the output to estimate as completion,
  // the preceding messages form the prompt history. Never call pop() on the
  // caller's array so a frozen/shared `messages` input is safe to pass.
  const outputMessage = messages[messages.length - 1]
  const historyMessages = messages.slice(0, -1)

  const prompt_tokens = await estimateHistoryTokens(assistant, historyMessages)
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
 * content blocks (text + reasoning + files + images), not from historical usage
 * fields. The assistant system prompt is added once. This ensures that two
 * different context windows with the same latest assistant but different
 * selected earlier turns yield different estimates.
 *
 * @param assistant - Used for the system prompt token estimate.
 * @param messages  - Pre-filtered message list.
 */
export async function estimateHistoryTokens(assistant: Assistant, messages: Message[]): Promise<number> {
  let totalTokens = 0

  // Estimate each message from content (text + reasoning + files + images).
  for (const message of messages) {
    const usage = await estimateMessageUsage(message)
    totalTokens += usage.total_tokens
  }

  // Add system prompt tokens.
  totalTokens += estimateTextTokens(assistant.prompt || '')

  return totalTokens
}
