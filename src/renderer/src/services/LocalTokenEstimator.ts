/**
 * 本地附件/消息 token 估算器
 *
 * 草稿（Inputbar 待发送内容）与历史消息共享的唯一本地估算入口：
 * - 文本/代码/Office：复用 prepareSendableFileText，估算所依据的文本与实际发送文本一致
 * - PDF：优先提取文本（可叠加页数开销），失败回退页数估算，最终回退有界字节估算
 * - 图片：基于分辨率的通用启发式（缩放 + 切片），压缩后字节数不参与主公式
 * - 远程 URL 图片：不下载，使用固定回退值
 *
 * 所有估算均为本地计算（不调用任何模型/远端 tokenizer），结果确定且非负。
 * 文件级估算通过有界 Promise 缓存去重并发读取；失败的缓存条目会被删除，
 * 调用方获得稳定的回退值。
 */

import { loggerService } from '@logger'
import { isPdfFile, isStoredFile, prepareSendableFileText } from '@renderer/aiCore/prepareParams/sendableFileText'
import type { FileMetadata } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { ImageMessageBlock, Message } from '@renderer/types/newMessage'
import {
  findFileBlocks,
  findImageBlocks,
  getMainTextContent,
  getThinkingContent
} from '@renderer/utils/messageUtils/find'
import { estimateTokenCount } from 'tokenx'

const logger = loggerService.withContext('LocalTokenEstimator')

// ---------------------------------------------------------------------------
// 通用图片估算常量（分辨率驱动，LOCK-007）
// ---------------------------------------------------------------------------

/** 每张图片的基础 token 开销 */
export const IMAGE_TOKENS_BASE = 85
/** 每个 512px 切片的 token 开销 */
export const IMAGE_TOKENS_PER_TILE = 170
/** 切片边长（像素） */
export const IMAGE_TILE_SIZE = 512
/** 缩放上限：长边不超过该值 */
export const IMAGE_MAX_LONG_EDGE = 2048
/** 缩放上限：短边不超过该值 */
export const IMAGE_MAX_SHORT_EDGE = 768
/** 分辨率不可得（远程 URL、加载失败）时的固定回退值，约等于 768×768 图片 */
export const IMAGE_FALLBACK_TOKENS = IMAGE_TOKENS_BASE + 4 * IMAGE_TOKENS_PER_TILE

// ---------------------------------------------------------------------------
// PDF 估算常量（LOCK-008）
// ---------------------------------------------------------------------------

/** 文本提取成功时，每页附加的结构开销 token */
export const PDF_PAGE_OVERHEAD_TOKENS = 8
/** 文本提取失败、页数可得时，每页的回退估算 token */
export const PDF_FALLBACK_TOKENS_PER_PAGE = 250

// ---------------------------------------------------------------------------
// 有界字节回退常量（最终兜底）
// ---------------------------------------------------------------------------

/** 字节回退换算率：约 4 字节 ≈ 1 token */
export const FALLBACK_BYTES_PER_TOKEN = 4
/** 字节回退上限，防止超大文件产生失真的天文数字 */
export const FALLBACK_MAX_TOKENS = 50_000

/**
 * 本地 token 估算结果（含分项）
 */
export interface LocalTokenEstimate {
  /** 文本（正文 + 推理内容）token 数 */
  textTokens: number
  /** 图片附件 token 数 */
  imageTokens: number
  /** 非图片文件附件（文本/代码/Office/PDF）token 数 */
  fileTokens: number
  /** 总计（textTokens + imageTokens + fileTokens） */
  totalTokens: number
}

/**
 * 估算文本内容的 token 数量
 */
export function estimateTextTokens(text: string): number {
  return estimateTokenCount(text)
}

/**
 * 基于图片分辨率的通用 token 估算公式：
 * 1. 缩放至长边 ≤ 2048、短边 ≤ 768
 * 2. 按 512px 切片计数
 * 3. tokens = 基础开销 + 切片数 × 每片开销
 *
 * 尺寸无效时返回固定回退值。
 */
export function estimateImageTokensFromDimensions(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return IMAGE_FALLBACK_TOKENS
  }

  let w = width
  let h = height

  const longEdge = Math.max(w, h)
  if (longEdge > IMAGE_MAX_LONG_EDGE) {
    const scale = IMAGE_MAX_LONG_EDGE / longEdge
    w *= scale
    h *= scale
  }

  const shortEdge = Math.min(w, h)
  if (shortEdge > IMAGE_MAX_SHORT_EDGE) {
    const scale = IMAGE_MAX_SHORT_EDGE / shortEdge
    w *= scale
    h *= scale
  }

  const tiles = Math.ceil(w / IMAGE_TILE_SIZE) * Math.ceil(h / IMAGE_TILE_SIZE)
  return IMAGE_TOKENS_BASE + tiles * IMAGE_TOKENS_PER_TILE
}

/**
 * 有界字节回退：size / 4，封顶 FALLBACK_MAX_TOKENS，非负
 */
function boundedSizeFallbackTokens(size: number): number {
  if (!Number.isFinite(size) || size <= 0) {
    return 0
  }
  return Math.min(Math.ceil(size / FALLBACK_BYTES_PER_TOKEN), FALLBACK_MAX_TOKENS)
}

/**
 * 通过渲染进程 Image 加载获取图片自然尺寸。
 * 仅用于本地数据（data URL）；失败时返回 null，不抛出。
 */
async function probeImageDimensions(src: string): Promise<{ width: number; height: number } | null> {
  if (typeof Image === 'undefined') {
    return null
  }
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      const width = image.naturalWidth || image.width
      const height = image.naturalHeight || image.height
      resolve(width > 0 && height > 0 ? { width, height } : null)
    }
    image.onerror = () => resolve(null)
    image.src = src
  })
}

// ---------------------------------------------------------------------------
// 有界 Promise 缓存（LOCK-009）
// ---------------------------------------------------------------------------

const MAX_CACHE_ENTRIES = 128

/** 以"足够不可变"的文件身份为键的估算结果缓存；存 Promise 以去重并发读取 */
const estimateCache = new Map<string, Promise<number>>()

function fileCacheKey(file: FileMetadata): string {
  return `${file.id}${file.ext}:${file.size}:${file.type}`
}

/** djb2 字符串哈希（确定、快速、非加密） */
function djb2(input: string): number {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return hash >>> 0
}

/**
 * 为 data URL 图片派生稳定且有界的缓存键。
 * 不将完整 URL 作为键（可能极长），而是用「头部 + 载荷长度 + 载荷哈希」标识身份，
 * 使相同 data URL 的重复估算命中缓存去重（LOCK-009）。
 */
function dataUrlCacheKey(url: string): string {
  const commaIndex = url.indexOf(',')
  const header = commaIndex >= 0 ? url.slice(0, commaIndex) : 'data:'
  const payload = commaIndex >= 0 ? url.slice(commaIndex + 1) : url
  return `dataurl:${header}:len=${payload.length}:${djb2(payload)}`
}

/**
 * 取缓存或计算。并发调用共享同一 Promise（读取去重）；
 * 计算 Promise 被拒绝时删除缓存条目（允许后续重试），
 * 调用方统一获得回退值，永不向外抛出。
 */
function getCachedEstimate(key: string, compute: () => Promise<number>, fallback: () => number): Promise<number> {
  let promise = estimateCache.get(key)
  if (!promise) {
    promise = compute()
    if (estimateCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = estimateCache.keys().next().value
      if (oldestKey !== undefined) {
        estimateCache.delete(oldestKey)
      }
    }
    estimateCache.set(key, promise)
    promise.catch(() => estimateCache.delete(key))
  }
  return promise.catch((error) => {
    logger.warn(`Token estimation failed for ${key}, using fallback:`, error as Error)
    return fallback()
  })
}

/**
 * 清空估算缓存（仅供测试使用）
 */
export function resetLocalTokenEstimatorCache(): void {
  estimateCache.clear()
}

// ---------------------------------------------------------------------------
// 分类型计算
// ---------------------------------------------------------------------------

/**
 * 本地图片文件：仅经 IPC 获取图片自然尺寸（不传输 base64 图片数据）→ 分辨率公式。
 * 分辨率不可得时由 estimateImageTokensFromDimensions 返回固定回退值
 * （压缩字节数不作为主公式，LOCK-007）。
 */
async function computeImageFileTokens(file: FileMetadata): Promise<number> {
  const { width, height } = isStoredFile(file)
    ? await window.api.file.imageSize(file.id + file.ext)
    : await window.api.file.imageSizeExternal(file.path)
  return estimateImageTokensFromDimensions(width, height)
}

/**
 * PDF 分层估算（LOCK-008）：
 * 1. 提取文本成功 → 文本 token（页数可得时叠加每页结构开销）
 * 2. 提取失败、页数可得 → 页数 × 每页回退值
 * 3. 均失败 → 有界字节回退
 */
async function computePdfTokens(file: FileMetadata): Promise<number> {
  let pageCount: number | null = null
  try {
    const count = isStoredFile(file)
      ? await window.api.file.pdfInfo(file.id + file.ext)
      : await window.api.file.pdfInfoExternal(file.path)
    pageCount = typeof count === 'number' && count > 0 ? count : null
  } catch (error) {
    logger.warn(`Failed to read PDF page count for ${file.origin_name}:`, error as Error)
  }

  try {
    const text = await prepareSendableFileText(file)
    if (text !== null) {
      return estimateTextTokens(text) + (pageCount ?? 0) * PDF_PAGE_OVERHEAD_TOKENS
    }
  } catch (error) {
    logger.warn(`Failed to extract PDF text for ${file.origin_name}:`, error as Error)
  }

  if (pageCount !== null) {
    return pageCount * PDF_FALLBACK_TOKENS_PER_PAGE
  }
  return boundedSizeFallbackTokens(file.size)
}

/**
 * 文本/代码/Office：复用 prepareSendableFileText，估算文本与实际发送文本一致（LOCK-006）。
 * 读取失败时回退有界字节估算。
 */
async function computeTextLikeTokens(file: FileMetadata): Promise<number> {
  const text = await prepareSendableFileText(file)
  if (text !== null) {
    return estimateTextTokens(text)
  }
  return boundedSizeFallbackTokens(file.size)
}

// ---------------------------------------------------------------------------
// 公开估算入口
// ---------------------------------------------------------------------------

/**
 * 估算单个文件附件的 token 数（带缓存与并发去重）。
 * 不支持以内容形式发送的类型（音频/视频/其他）返回 0。
 */
export function estimateFileTokens(file: FileMetadata): Promise<number> {
  const key = fileCacheKey(file)

  if (file.type === FILE_TYPE.IMAGE) {
    return getCachedEstimate(
      key,
      () => computeImageFileTokens(file),
      () => IMAGE_FALLBACK_TOKENS
    )
  }

  if (isPdfFile(file)) {
    return getCachedEstimate(
      key,
      () => computePdfTokens(file),
      () => boundedSizeFallbackTokens(file.size)
    )
  }

  if (file.type === FILE_TYPE.TEXT || file.type === FILE_TYPE.DOCUMENT) {
    return getCachedEstimate(
      key,
      () => computeTextLikeTokens(file),
      () => boundedSizeFallbackTokens(file.size)
    )
  }

  return Promise.resolve(0)
}

/**
 * 估算 ImageMessageBlock 的 token 数：
 * - 本地上传文件 → 文件路径（分辨率驱动，带缓存）
 * - data URL → 直接解析分辨率
 * - 远程 URL → 固定回退值（绝不下载，LOCK-003）
 */
export async function estimateImageBlockTokens(block: ImageMessageBlock): Promise<number> {
  if (block.file) {
    return estimateFileTokens(block.file)
  }

  const url = block.url
  if (!url) {
    return 0
  }

  if (url.startsWith('data:')) {
    // data URL 内容确定不变：以有界派生键缓存，去重重复估算（LOCK-009）。
    return getCachedEstimate(
      dataUrlCacheKey(url),
      async () => {
        const dimensions = await probeImageDimensions(url)
        return dimensions
          ? estimateImageTokensFromDimensions(dimensions.width, dimensions.height)
          : IMAGE_FALLBACK_TOKENS
      },
      () => IMAGE_FALLBACK_TOKENS
    )
  }

  return IMAGE_FALLBACK_TOKENS
}

/**
 * 估算草稿（待发送文本 + 附件）的 token 数（LOCK-005：与历史共用同一估算器）
 */
export async function estimateDraftTokens({
  content,
  files
}: {
  content?: string
  files?: FileMetadata[]
}): Promise<LocalTokenEstimate> {
  const textTokens = estimateTextTokens(content || '')
  const fileList = files ?? []
  const perFileTokens = await Promise.all(fileList.map((file) => estimateFileTokens(file)))

  let imageTokens = 0
  let fileTokens = 0
  fileList.forEach((file, index) => {
    if (file.type === FILE_TYPE.IMAGE) {
      imageTokens += perFileTokens[index]
    } else {
      fileTokens += perFileTokens[index]
    }
  })

  return { textTokens, imageTokens, fileTokens, totalTokens: textTokens + imageTokens + fileTokens }
}

/**
 * 估算完整消息的 token 数：正文 + 推理内容 + 文件块 + 图片块。
 * FileMessageBlock 与 ImageMessageBlock 均被识别；独立附件并发估算。
 */
export async function estimateMessageTokens(message: Message): Promise<LocalTokenEstimate> {
  const content = getMainTextContent(message)
  const reasoningContent = getThinkingContent(message)
  const combinedContent = [content, reasoningContent].filter((s) => s !== undefined).join(' ')
  const textTokens = estimateTextTokens(combinedContent)

  const fileBlocks = findFileBlocks(message)
  const imageBlocks = findImageBlocks(message)

  const [fileBlockTokens, imageBlockTokens] = await Promise.all([
    Promise.all(fileBlocks.map((block) => estimateFileTokens(block.file))),
    Promise.all(imageBlocks.map((block) => estimateImageBlockTokens(block)))
  ])

  let imageTokens = imageBlockTokens.reduce((acc, tokens) => acc + tokens, 0)
  let fileTokens = 0
  fileBlocks.forEach((block, index) => {
    if (block.file?.type === FILE_TYPE.IMAGE) {
      imageTokens += fileBlockTokens[index]
    } else {
      fileTokens += fileBlockTokens[index]
    }
  })

  return { textTokens, imageTokens, fileTokens, totalTokens: textTokens + imageTokens + fileTokens }
}
