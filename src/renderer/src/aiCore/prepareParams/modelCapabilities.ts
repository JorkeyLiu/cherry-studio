/**
 * 模型能力检查模块
 * 检查不同模型支持的功能（PDF输入、图片输入、大文件上传等）
 */

import { getProviderByModel } from '@renderer/services/AssistantService'
import type { Model } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'

import { getAiSdkProviderId } from '../provider/factory'

// 工具函数：基于模型名和提供商判断是否支持某特性
function modelSupportValidator(
  model: Model,
  {
    supportedModels = [],
    unsupportedModels = [],
    supportedProviders = [],
    unsupportedProviders = []
  }: {
    supportedModels?: string[]
    unsupportedModels?: string[]
    supportedProviders?: string[]
    unsupportedProviders?: string[]
  }
): boolean {
  const provider = getProviderByModel(model)
  if (!provider) {
    // Unconfigured model/provider: fail explicitly before any provider/API access.
    return false
  }
  const aiSdkId = getAiSdkProviderId(provider)

  // 黑名单：命中不支持的模型直接拒绝
  if (unsupportedModels.some((name) => model.name.includes(name))) {
    return false
  }

  // 黑名单：命中不支持的提供商直接拒绝，常用于某些提供商的同名模型并不具备原模型的某些特性
  if (unsupportedProviders.includes(aiSdkId)) {
    return false
  }

  // 白名单：命中支持的模型名
  if (supportedModels.some((name) => model.name.includes(name))) {
    return true
  }

  // 回退到提供商判断
  return supportedProviders.includes(aiSdkId)
}

/**
 * 检查模型是否支持原生图片输入
 *
 * Unit B (user-intent lazy execution): image encodability is a protocol/endpoint
 * fact, not a model-capability grant. Every ordinary-chat adapter below can
 * encode AI SDK ImagePart/FilePart images; upstream rejection surfaces through
 * the existing APICallError chain instead of silent local omission.
 */
export function supportsImageInput(model: Model): boolean {
  const provider = getProviderByModel(model)
  if (!provider) {
    return false
  }
  const aiSdkId = getAiSdkProviderId(provider)
  return ['openai', 'openai-chat', 'openai-compatible', 'anthropic', 'google'].includes(aiSdkId)
}

/**
 * Single source of truth for audio/video encodability.
 *
 * - OpenAI Chat (`openai-chat`) / generic compatible (`openai-compatible`):
 *   strictly `.wav`/`.mp3` only. `.mp3` already resolves to `audio/mpeg`;
 *   `.mpeg`/`.mpga` extensions are never admitted even though they share the
 *   same MIME.
 * - Gemini (`google`): only extensions with a reliable MIME mapping that the
 *   SDK can encode (wav/mp3/ogg/flac/aac audio, mp4/mov/webm video).
 * - Responses (`openai`) and Anthropic (`anthropic`): no audio/video.
 */
export const OPENAI_AUDIO_MIME_BY_EXT: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
}

export const GEMINI_AUDIO_MIME_BY_EXT: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac'
}

export const AUDIO_MIME_BY_EXT: Record<string, string> = OPENAI_AUDIO_MIME_BY_EXT

export const VIDEO_MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm'
}

function audioVideoAdapter(model: Model): string | null {
  const provider = getProviderByModel(model)
  if (!provider) return null
  return getAiSdkProviderId(provider)
}

export function resolveAudioMime(ext?: string, aiSdkId?: string): string | undefined {
  const normalized = (ext ?? '').toLowerCase()
  if (aiSdkId === 'google') {
    return GEMINI_AUDIO_MIME_BY_EXT[normalized]
  }
  if (aiSdkId === 'openai-chat' || aiSdkId === 'openai-compatible') {
    return OPENAI_AUDIO_MIME_BY_EXT[normalized]
  }
  if (aiSdkId === undefined) {
    // Adapter-agnostic lookup (kept for tooling): OpenAI WAV/MP3 truth.
    return OPENAI_AUDIO_MIME_BY_EXT[normalized]
  }
  // Responses (`openai`), Anthropic, and any other adapter encode no audio.
  return undefined
}

export function resolveVideoMime(ext?: string): string | undefined {
  return VIDEO_MIME_BY_EXT[(ext ?? '').toLowerCase()]
}

export function supportsAudioInput(model: Model, ext?: string): boolean {
  const aiSdkId = audioVideoAdapter(model)
  if (!aiSdkId) return false
  // Same mapping as the encoder: no fork between selector and FilePart path.
  return resolveAudioMime(ext, aiSdkId) !== undefined
}

export function supportsVideoInput(model: Model, ext?: string): boolean {
  const aiSdkId = audioVideoAdapter(model)
  if (aiSdkId !== 'google') return false
  // Same mapping as the encoder: only mp4/mov/webm are reliably encodable.
  return resolveVideoMime(ext) !== undefined
}

/**
 * 检查提供商是否支持大文件上传（如Gemini File API）
 */
export function supportsLargeFileUpload(model: Model): boolean {
  // Protocol-derived AI SDK id only (`google` for the Gemini protocol).
  // Retired brand adapters resolve through generic OpenAI-compatible and
  // never reach a brand-specific bucket here.
  return modelSupportValidator(model, {
    supportedModels: ['qwen-long', 'qwen-doc'],
    supportedProviders: ['google']
  })
}

/**
 * 获取提供商特定的文件大小限制
 */
export function getFileSizeLimit(model: Model, fileType: string | null): number {
  const provider = getProviderByModel(model)
  if (!provider) {
    // Unconfigured model/provider: fail explicitly before any provider/API access.
    return 0
  }
  const aiSdkId = getAiSdkProviderId(provider)

  // Anthropic PDF限制32MB
  if (aiSdkId === 'anthropic' && fileType === FILE_TYPE.DOCUMENT) {
    return 32 * 1024 * 1024 // 32MB
  }

  // Gemini小文件限制20MB（超过此限制会使用File API上传）
  if (aiSdkId === 'google') {
    return 20 * 1024 * 1024 // 20MB
  }

  // 其他提供商没有明确限制，使用较大的默认值
  // 这与Legacy架构中的实现一致，让提供商自行处理文件大小
  return Infinity
}
