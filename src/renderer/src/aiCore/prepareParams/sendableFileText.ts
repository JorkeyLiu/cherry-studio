/**
 * 可发送文件文本准备模块
 *
 * 定义"文件名 + 换行 + 提取内容"这一唯一的可发送文本构造边界。
 * 消息转换（convertFileBlockToTextPart）与本地 token 估算必须复用同一路径，
 * 以保证估算所依据的文本与实际发送给模型的文本完全一致。
 */

import type { FileMetadata } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'

/**
 * 判断文件是否以提取文本的形式发送（文本/代码/Office 文档等）
 */
export function isTextSendableFile(file: FileMetadata): boolean {
  return file.type === FILE_TYPE.TEXT || file.type === FILE_TYPE.DOCUMENT
}

/**
 * 判断 FileMetadata 是否指向已入库（storageDir）的文件。
 *
 * 入库文件（历史消息、上传后的附件）：`path` 结尾为 `${id}${ext}`，
 * 因此存在于 storageDir 下，可通过 storage-id API（read/base64Image/pdfInfo）读取。
 *
 * 预上传草稿文件（select/paste/drop 经 file.get 产生）：`id` 是全新 uuid，
 * `path` 指向原始/临时文件，storageDir 下 `${id}${ext}` 尚不存在，
 * 必须通过 path-based API（readExternal/base64ImageExternal/pdfInfoExternal）读取。
 *
 * 该判定确定性成立、无需先失败再回退，避免重复告警/IPC 循环。
 */
export function isStoredFile(file: FileMetadata): boolean {
  return Boolean(file.path) && file.path.endsWith(`${file.id}${file.ext}`)
}

/**
 * 读取文件的可发送文本内容，自动在 storage-id 与 path 两种来源间选择：
 * - 入库文件：storage-id 主路径（历史消息可靠）
 * - 预上传草稿：原始 path 路径（草稿预览可靠）
 *
 * detectEncoding 语义与既有转换器一致：文本文件为 false，文档（Office/PDF）为 true
 * （文档走主进程文本提取，与实际发送内容一致）。
 */
export function readSendableFileContent(file: FileMetadata, detectEncoding: boolean): Promise<string> {
  if (isStoredFile(file)) {
    return window.api.file.read(file.id + file.ext, detectEncoding)
  }
  return window.api.file.readExternal(file.path, detectEncoding)
}

/**
 * 构造实际发送给模型的文件文本：文件名 + 换行 + 去除首尾空白的提取内容
 */
export function buildSendableFileText(fileName: string, extractedContent: string): string {
  return `${fileName}\n${extractedContent.trim()}`
}

/**
 * 读取并构造文件的可发送文本。
 *
 * 来源解析统一走 readSendableFileContent：入库文件用 storage-id 读取（历史消息），
 * 预上传草稿用原始 path 读取（select/paste/drop），两者产出相同的「文件名 + 内容」形状。
 *
 * - TEXT 文件：detectEncoding=false
 * - DOCUMENT 文件（PDF、Word、Excel 等）：detectEncoding=true（走主进程文本提取/编码探测）
 * - 其他类型：返回 null（不以文本形式发送）
 *
 * 读取失败时向上抛出，由调用方决定回退语义（转换器回退为 null 并提示，估算方可自行处理）。
 */
export async function prepareSendableFileText(file: FileMetadata): Promise<string | null> {
  if (file.type === FILE_TYPE.TEXT) {
    const fileContent = await readSendableFileContent(file, false)
    return buildSendableFileText(file.origin_name, fileContent)
  }

  if (file.type === FILE_TYPE.DOCUMENT) {
    const fileContent = await readSendableFileContent(file, true) // true表示强制文本提取/编码探测
    return buildSendableFileText(file.origin_name, fileContent)
  }

  return null
}
