/**
 * 文件处理模块
 * 处理文件内容提取、文件格式转换、文件上传等逻辑
 */

import type OpenAI from '@cherrystudio/openai'
import { loggerService } from '@logger'
import { getProviderByModel } from '@renderer/services/AssistantService'
import type { FileMetadata, Message, Model } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { FileMessageBlock } from '@renderer/types/newMessage'
import { findFileBlocks } from '@renderer/utils/messageUtils/find'
import type { FilePart, TextPart } from 'ai'

import { getAiSdkProviderId } from '../provider/factory'
import { attachmentFailedError, attachmentTextExtractionError, isAttachmentError } from './attachmentErrors'
import {
  getFileSizeLimit,
  resolveAudioMime,
  resolveVideoMime,
  supportsImageInput,
  supportsLargeFileUpload
} from './modelCapabilities'
import { getSendableFileText, isPdfFile } from './sendableFileText'

const logger = loggerService.withContext('fileProcessor')

/**
 * 提取文件内容
 */
export async function extractFileContent(message: Message): Promise<string> {
  const fileBlocks = findFileBlocks(message)
  if (fileBlocks.length > 0) {
    const textFileBlocks = fileBlocks.filter(
      (fb) => fb.file && [FILE_TYPE.TEXT, FILE_TYPE.DOCUMENT].some((type) => fb.file.type === type)
    )

    if (textFileBlocks.length > 0) {
      let text = ''
      const divider = '\n\n---\n\n'

      for (const fileBlock of textFileBlocks) {
        const file = fileBlock.file
        const fileContent = (await window.api.file.read(file.id + file.ext)).trim()
        const fileNameRow = 'file: ' + file.origin_name + '\n\n'
        text = text + fileNameRow + fileContent + divider
      }

      return text
    }
  }

  return ''
}

/**
 * 将文件块转换为文本部分
 *
 * 文本构造统一走 getSendableFileText（prepareSendableFileText 的共享缓存入口），
 * 确保发送内容与本地估算内容一致，且同一文件身份只读取/解析一次。
 *
 * Unit B atomicity: text extraction failure aborts the request with a
 * displayable English technical error (no locale writes). Returning null means
 * "not text-extractable, caller may try another encoding"; throwing means the
 * attachment failed and the request must stop (never silently send text-only).
 */
export async function convertFileBlockToTextPart(fileBlock: FileMessageBlock): Promise<TextPart | null> {
  const file = fileBlock.file

  // 处理文本文件与文档文件（PDF、Word、Excel等）- 提取为文本内容
  try {
    const text = await getSendableFileText(file)
    if (text !== null) {
      return { type: 'text', text }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw attachmentTextExtractionError(file.origin_name, file.type ?? 'unknown type', reason)
  }

  return null
}

/**
 * 处理Gemini大文件上传
 *
 * Successful existing/new uploads always produce a sendable FilePart backed
 * by the Files API URI (`fileData.fileUri` on the Google provider: FilePart
 * with `data` as URL). Failures throw with the concrete root cause so the
 * caller aborts instead of silently downgrading.
 */
export function geminiRemoteFileToFilePart(
  remoteFile: { uri?: string; mimeType?: string; name?: string },
  fallbackName: string,
  fallbackMime = 'application/pdf'
): FilePart | null {
  const uri = remoteFile.uri
  if (!uri) {
    return null
  }
  let data: URL
  try {
    data = new URL(uri)
  } catch {
    return null
  }
  return {
    type: 'file',
    data,
    mediaType: remoteFile.mimeType || fallbackMime,
    filename: fallbackName
  }
}

export async function handleGeminiFileUpload(file: FileMetadata, model: Model): Promise<FilePart | null> {
  const provider = getProviderByModel(model)
  if (!provider) {
    // Unconfigured model/provider: fail explicitly before any provider/API access.
    throw attachmentFailedError(file.origin_name, file.type ?? 'unknown type', 'model provider is not configured')
  }

  const fail = (reason: string): Error => attachmentFailedError(file.origin_name, file.type ?? 'unknown type', reason)

  try {
    // 检查文件是否已经上传过
    const fileMetadata = await window.api.fileService.retrieve(provider, file.id)

    if (fileMetadata.status === 'success' && fileMetadata.originalFile?.file) {
      const remoteFile = fileMetadata.originalFile.file as unknown as {
        uri?: string
        mimeType?: string
        name?: string
      }
      const part = geminiRemoteFileToFilePart(remoteFile, file.origin_name)
      if (part) {
        logger.info(`File ${file.origin_name} already uploaded to Gemini with URI: ${remoteFile.uri}`)
        return part
      }
      throw fail(`existing Gemini upload for "${file.origin_name}" has no usable file URI (status success without uri)`)
    }
    if (fileMetadata.status === 'processing') {
      throw fail(`existing Gemini upload for "${file.origin_name}" is still processing`)
    }
    // Non-success retrieve (failed/unknown/missing) falls through to upload;
    // the upload error below carries the root cause.

    // 如果文件未上传，执行上传
    const uploadResult = await window.api.fileService.upload(provider, file)
    if (uploadResult.status === 'success' && uploadResult.originalFile?.file) {
      const remoteFile = uploadResult.originalFile.file as unknown as {
        uri?: string
        mimeType?: string
        name?: string
      }
      const part = geminiRemoteFileToFilePart(remoteFile, file.origin_name)
      if (part) {
        logger.info(`File ${file.origin_name} uploaded to Gemini with URI: ${remoteFile.uri}`)
        return part
      }
      throw fail(`Gemini upload for "${file.origin_name}" succeeded without a usable file URI`)
    }
    throw fail(
      `Gemini upload for "${file.origin_name}" failed with status "${uploadResult.status}" (retrieve status "${fileMetadata.status}")`
    )
  } catch (error) {
    if (isAttachmentError(error)) throw error
    throw fail(error instanceof Error ? error.message : String(error))
  }
}

/**
 * 处理OpenAI兼容大文件上传
 */
export async function handleOpenAILargeFileUpload(
  file: FileMetadata,
  model: Model
): Promise<(FilePart & { id?: string }) | null> {
  const provider = getProviderByModel(model)
  if (!provider) {
    // Unconfigured model/provider: fail explicitly before any provider/API access.
    return null
  }
  // 如果模型为qwen-long系列，文档中要求purpose需要为'file-extract'
  if (['qwen-long', 'qwen-doc'].some((modelName) => model.name.includes(modelName))) {
    file = {
      ...file,
      // 该类型并不在OpenAI定义中，但符合sdk规范，强制断言
      purpose: 'file-extract' as OpenAI.FilePurpose
    }
  }
  const fail = (reason: string): Error => attachmentFailedError(file.origin_name, file.type ?? 'unknown type', reason)
  try {
    // 检查文件是否已经上传过
    const fileMetadata = await window.api.fileService.retrieve(provider, file.id)
    if (fileMetadata.status === 'success' && fileMetadata.originalFile?.file) {
      // 断言OpenAIFile对象
      const remoteFile = fileMetadata.originalFile.file as OpenAI.Files.FileObject
      // 判断用途是否一致
      if (remoteFile.purpose !== file.purpose) {
        throw fail(`File purpose mismatch: remote "${remoteFile.purpose}" vs local "${file.purpose}"`)
      }
      return {
        type: 'file',
        filename: file.origin_name,
        mediaType: '',
        data: `fileid://${remoteFile.id}`
      }
    }
    if (fileMetadata.status !== 'success') {
      logger.info(`OpenAI retrieve for ${file.origin_name} returned "${fileMetadata.status}", attempting upload`)
    }
  } catch (error) {
    if (isAttachmentError(error)) throw error
    throw fail(`retrieve failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    // 如果文件未上传，执行上传
    const uploadResult = await window.api.fileService.upload(provider, file)
    if (uploadResult.status === 'success' && uploadResult.originalFile?.file) {
      // 断言OpenAIFile对象
      const remoteFile = uploadResult.originalFile.file as OpenAI.Files.FileObject
      logger.info(`File ${file.origin_name} uploaded.`)
      return {
        type: 'file',
        filename: remoteFile.filename,
        mediaType: '',
        data: `fileid://${remoteFile.id}`
      }
    }
    throw fail(`upload failed with status "${uploadResult.status}"`)
  } catch (error) {
    if (isAttachmentError(error)) throw error
    throw fail(`upload failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 大文件上传路由函数
 */
export async function handleLargeFileUpload(
  file: FileMetadata,
  model: Model
): Promise<(FilePart & { id?: string }) | null> {
  const provider = getProviderByModel(model)
  if (!provider) {
    // Unconfigured model/provider: fail explicitly before any provider/API access.
    return null
  }
  const aiSdkId = getAiSdkProviderId(provider)

  if (aiSdkId === 'google') {
    return await handleGeminiFileUpload(file, model)
  }

  if (provider.type === 'openai') {
    return await handleOpenAILargeFileUpload(file, model)
  }

  return null
}

/**
 * 将文件块转换为FilePart（用于原生文件支持）
 *
 * Unit B semantics:
 * - Return a FilePart when the current endpoint/adapter can natively encode
 *   the attachment.
 * - Return null ONLY when this file kind is not natively encodable here and
 *   the caller should try text extraction (e.g. Word/Excel documents).
 * - Throw (English technical error with filename/type/reason, no locale) when
 *   a natively-encodable attachment fails to read/convert/upload, or when the
 *   protocol matrix cannot encode it. Callers must abort the request, never
 *   silently continue with text-only.
 */
export async function convertFileBlockToFilePart(fileBlock: FileMessageBlock, model: Model): Promise<FilePart | null> {
  const file = fileBlock.file
  const fileSizeLimit = getFileSizeLimit(model, file.type)
  const fail = (reason: string): Error => attachmentFailedError(file.origin_name, file.type ?? 'unknown type', reason)

  try {
    // 处理PDF文档（始终生成 FilePart，由下游插件处理兼容性）
    // 分类统一走 isPdfFile，扩展名大小写归一，与本地估算路径保持一致。
    if (isPdfFile(file)) {
      // 检查文件大小限制
      if (file.size > fileSizeLimit) {
        // 如果支持大文件上传（如Gemini File API），尝试上传
        if (supportsLargeFileUpload(model)) {
          logger.info(`Large PDF file ${file.origin_name} (${file.size} bytes) attempting File API upload`)
          const uploadResult = await handleLargeFileUpload(file, model)
          if (uploadResult) {
            return uploadResult
          }
          throw fail('upload failed and no text downgrade is attempted for oversized PDFs')
        } else {
          throw fail(
            `file size ${file.size} exceeds protocol limit ${fileSizeLimit} and the current endpoint has no large-file upload`
          )
        }
      }

      try {
        const base64Data = await window.api.file.base64File(file.id + file.ext)
        return {
          type: 'file',
          data: base64Data.data,
          mediaType: base64Data.mime,
          filename: file.origin_name
        }
      } catch (error) {
        throw fail(error instanceof Error ? error.message : String(error))
      }
    }

    // 处理图片文件：encodability is endpoint-based (supportsImageInput), never
    // vision metadata. Unencodable images fail explicitly; read failures abort.
    if (file.type === FILE_TYPE.IMAGE) {
      if (!supportsImageInput(model)) {
        throw fail('the current endpoint/adapter cannot encode images')
      }
      // 检查文件大小
      if (file.size > fileSizeLimit) {
        throw fail(`file size ${file.size} exceeds protocol limit ${fileSizeLimit}`)
      }

      try {
        const base64Data = await window.api.file.base64Image(file.id + file.ext)

        // 处理MIME类型，特别是jpg->jpeg的转换（Anthropic要求）
        let mediaType = base64Data.mime
        const provider = getProviderByModel(model)
        if (!provider) {
          throw fail('model provider is not configured')
        }
        const aiSdkId = getAiSdkProviderId(provider)

        if (aiSdkId === 'anthropic' && mediaType === 'image/jpg') {
          mediaType = 'image/jpeg'
        }
        if (!mediaType || !mediaType.startsWith('image/')) {
          throw fail(`unreliable image MIME "${mediaType}"`)
        }

        return {
          type: 'file',
          data: base64Data.base64,
          mediaType: mediaType,
          filename: file.origin_name
        }
      } catch (error) {
        if (isAttachmentError(error)) throw error
        throw fail(error instanceof Error ? error.message : String(error))
      }
    }

    // 处理音频/视频：endpoint/adapter matrix only (never model metadata).
    // OpenAI Chat/compatible: WAV/MP3 audio only; Gemini: audio + video;
    // Responses + Anthropic: no audio/video; other chat: video unsupported.
    if (file.type === FILE_TYPE.AUDIO || file.type === FILE_TYPE.VIDEO) {
      const provider = getProviderByModel(model)
      if (!provider) {
        throw fail('model provider is not configured')
      }
      const aiSdkId = getAiSdkProviderId(provider)
      const ext = (file.ext ?? '').toLowerCase()

      if (file.type === FILE_TYPE.AUDIO) {
        // Single matrix: the same adapter-aware resolver backs
        // supportsAudioInput and the encoder (no fork).
        const mime = resolveAudioMime(ext, aiSdkId)
        if (!mime) {
          throw fail(
            aiSdkId === 'openai-chat' || aiSdkId === 'openai-compatible'
              ? `audio format "${file.ext}" cannot be encoded on this endpoint (only WAV/MP3)`
              : `audio format "${file.ext}" cannot be encoded on the ${aiSdkId} endpoint`
          )
        }
        try {
          const base64Data = await window.api.file.base64File(file.id + file.ext)
          return { type: 'file', data: base64Data.data, mediaType: mime, filename: file.origin_name }
        } catch (error) {
          throw fail(error instanceof Error ? error.message : String(error))
        }
      }

      // VIDEO
      if (aiSdkId !== 'google') {
        throw fail(
          aiSdkId === 'openai' || aiSdkId === 'anthropic'
            ? `video is not supported on the ${aiSdkId} endpoint`
            : `video cannot be encoded on the ${aiSdkId} endpoint`
        )
      }
      const mime = resolveVideoMime(ext)
      if (!mime) {
        throw fail(`video format "${file.ext}" cannot be reliably encoded on this endpoint`)
      }
      try {
        const base64Data = await window.api.file.base64File(file.id + file.ext)
        return { type: 'file', data: base64Data.data, mediaType: mime, filename: file.origin_name }
      } catch (error) {
        throw fail(error instanceof Error ? error.message : String(error))
      }
    }

    // 处理其他文档类型（Word、Excel等）
    if (file.type === FILE_TYPE.DOCUMENT && !isPdfFile(file)) {
      // 目前大多数提供商不支持Word等格式的原生处理
      // 返回null会触发上层调用convertFileBlockToTextPart进行文本提取
      // 这与Legacy架构中的处理方式一致
      logger.debug(`Document file ${file.origin_name} with extension ${file.ext} will use text extraction fallback`)
      return null
    }
  } catch (error) {
    if (isAttachmentError(error)) throw error
    throw fail(error instanceof Error ? error.message : String(error))
  }

  return null
}
