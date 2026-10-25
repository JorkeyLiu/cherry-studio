import OpenAI from '@cherrystudio/openai'
import { loggerService } from '@logger'
import { fileStorage } from '@main/services/FileStorage'
import { resolveOutboundRequestHeaders } from '@shared/aiCore/provider/utils/requestHeaders'
import type { FileListResponse, FileMetadata, FileUploadResponse, Provider } from '@types'
import * as fs from 'fs'

import { CacheService } from '../CacheService'
import { BaseFileService } from './BaseFileService'

const logger = loggerService.withContext('OpenAIService')

export class OpenaiService extends BaseFileService {
  private static readonly FILE_CACHE_DURATION = 7 * 24 * 60 * 60 * 1000
  private static readonly generateUIFileIdCacheKey = (fileId: string) => `ui_file_id_${fileId}`
  private readonly client: OpenAI

  constructor(provider: Provider) {
    super(provider)
    // Provider custom headers flow per request (see resolveFileRequestHeaders)
    // so the long-lived client carries no baked session identity. Bodies,
    // purpose, and error semantics below are untouched.
    this.client = new OpenAI({
      apiKey: provider.apiKey,
      baseURL: provider.apiHost
    })
  }

  /**
   * Shared cross-runtime header policy for file requests (topicless: file
   * operations carry no topic, so this is the topicless logical-request
   * identity — one opaque value per method invocation on the Go endpoint
   * only). Resolved per method call, hence constant for that
   * invocation/retries and never persisted. Provider custom headers
   * (`Provider.extra_headers`) flow alongside; credentials stay in the client.
   */
  private resolveFileRequestHeaders(): Record<string, string> | undefined {
    const providerExtra = this.provider.extra_headers as Record<string, string | undefined> | undefined
    const resolved = resolveOutboundRequestHeaders({
      apiHost: this.provider.apiHost,
      providerExtraHeaders: providerExtra
    })
    const merged: Record<string, string> = {}
    if (providerExtra) {
      for (const [key, value] of Object.entries(providerExtra)) {
        if (value !== undefined) {
          merged[key] = value
        }
      }
    }
    if (resolved) {
      for (const [key, value] of Object.entries(resolved)) {
        if (value !== undefined) {
          merged[key] = value
        }
      }
    }
    return Object.keys(merged).length > 0 ? merged : undefined
  }

  async uploadFile(file: FileMetadata): Promise<FileUploadResponse> {
    let fileReadStream: fs.ReadStream | undefined
    try {
      fileReadStream = fs.createReadStream(fileStorage.getFilePathById(file))
      // 还原文件原始名，以提高模型对文件的理解
      const fileStreamWithMeta = Object.assign(fileReadStream, {
        name: file.origin_name
      })
      const fileHeaders = this.resolveFileRequestHeaders()
      const response = await this.client.files.create(
        {
          file: fileStreamWithMeta,
          purpose: file.purpose || 'assistants'
        },
        ...(fileHeaders ? [{ headers: fileHeaders } as const] : [])
      )
      if (!response.id) {
        throw new Error('File id not found in response')
      }
      // 映射RemoteFileId到UIFileId上
      CacheService.set<string>(
        OpenaiService.generateUIFileIdCacheKey(file.id),
        response.id,
        OpenaiService.FILE_CACHE_DURATION
      )
      return {
        fileId: response.id,
        displayName: file.origin_name,
        status: 'success',
        originalFile: {
          type: 'openai',
          file: response
        }
      }
    } catch (error) {
      logger.error('Error uploading file:', error as Error)
      return {
        fileId: '',
        displayName: file.origin_name,
        status: 'failed'
      }
    } finally {
      // 销毁文件流
      if (fileReadStream) fileReadStream.destroy()
    }
  }

  async listFiles(): Promise<FileListResponse> {
    try {
      const fileHeaders = this.resolveFileRequestHeaders()
      const response = await (fileHeaders
        ? this.client.files.list(undefined, { headers: fileHeaders })
        : this.client.files.list())
      return {
        files: response.data.map((file) => ({
          id: file.id,
          displayName: file.filename || '',
          size: file.bytes,
          status: 'success', // All listed files are processed,
          originalFile: {
            type: 'openai',
            file
          }
        }))
      }
    } catch (error) {
      logger.error('Error listing files:', error as Error)
      return { files: [] }
    }
  }

  async deleteFile(fileId: string): Promise<void> {
    try {
      const cachedRemoteFileId = CacheService.get<string>(OpenaiService.generateUIFileIdCacheKey(fileId))
      const fileHeaders = this.resolveFileRequestHeaders()
      await (fileHeaders
        ? this.client.files.delete(cachedRemoteFileId || fileId, { headers: fileHeaders })
        : this.client.files.delete(cachedRemoteFileId || fileId))
      logger.debug(`File ${fileId} deleted`)
    } catch (error) {
      logger.error('Error deleting file:', error as Error)
      throw error
    }
  }

  async retrieveFile(fileId: string): Promise<FileUploadResponse> {
    try {
      // 尝试反映射RemoteFileId
      const cachedRemoteFileId = CacheService.get<string>(OpenaiService.generateUIFileIdCacheKey(fileId))
      const fileHeaders = this.resolveFileRequestHeaders()
      const response = await (fileHeaders
        ? this.client.files.retrieve(cachedRemoteFileId || fileId, { headers: fileHeaders })
        : this.client.files.retrieve(cachedRemoteFileId || fileId))

      return {
        fileId: response.id,
        displayName: response.filename,
        status: 'success',
        originalFile: {
          type: 'openai',
          file: response
        }
      }
    } catch (error) {
      logger.error('Error retrieving file:', error as Error)
      return {
        fileId: fileId,
        displayName: '',
        status: 'failed',
        originalFile: undefined
      }
    }
  }
}
