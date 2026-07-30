import FileManager from '@renderer/services/FileManager'
import type { FileMetadata } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus } from '@renderer/types/newMessage'
import { createFileBlock, createImageBlock } from '@renderer/utils/messageUtils/create'

export interface StagedAttachmentUpload {
  block: MessageBlock
  file: FileMetadata
}

export interface StageAttachmentUploadsResult {
  blocks: MessageBlock[]
  remainingFiles: FileMetadata[]
  stagedUploads: StagedAttachmentUpload[]
  error?: unknown
}

export const stageAttachmentUploads = async (
  messageId: string,
  blocks: MessageBlock[],
  files: FileMetadata[],
  uploadFile: (file: FileMetadata) => Promise<FileMetadata> = FileManager.uploadFile
): Promise<StageAttachmentUploadsResult> => {
  if (files.length === 0) return { blocks, remainingFiles: files, stagedUploads: [] }

  const results = await Promise.allSettled(files.map((file) => uploadFile(file)))
  const stagedUploads: StagedAttachmentUpload[] = []
  const remainingFiles: FileMetadata[] = []
  let error: unknown

  results.forEach((result, index) => {
    const file = files[index]
    if (result.status === 'fulfilled') {
      const uploadedFile = result.value
      const block =
        uploadedFile.type === FILE_TYPE.IMAGE
          ? createImageBlock(messageId, { file: uploadedFile, status: MessageBlockStatus.SUCCESS })
          : createFileBlock(messageId, uploadedFile, { status: MessageBlockStatus.SUCCESS })
      stagedUploads.push({ block, file: uploadedFile })
    } else {
      remainingFiles.push(file)
      error ??= result.reason
    }
  })

  return {
    blocks: [...blocks, ...stagedUploads.map(({ block }) => block)],
    remainingFiles,
    stagedUploads,
    error
  }
}

export const releaseStagedAttachmentUploads = async (stagedUploads: Map<string, FileMetadata>): Promise<void> => {
  if (stagedUploads.size === 0) return

  const results = await Promise.allSettled(
    [...stagedUploads].map(async ([blockId, file]) => {
      await FileManager.deleteFile(file.id)
      stagedUploads.delete(blockId)
    })
  )
  const failed = results.filter((result) => result.status === 'rejected')
  if (failed.length > 0) {
    throw new AggregateError(
      failed.map((result) => result.reason),
      `Failed to release ${failed.length} message editor attachment(s)`
    )
  }
}
