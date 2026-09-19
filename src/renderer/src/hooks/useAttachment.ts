import { loggerService } from '@logger'
import TextFilePreviewPopup from '@renderer/components/Popups/TextFilePreview'
import { FILE_TYPE } from '@renderer/types'
import type { MediaAttachmentOpenRequest } from '@shared/mediaAttachment'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('FileAction')

/**
 * 处理附件点击事件：
 * 如果是文本文件，在 Preview 视图中打开，
 * 否则使用默认打开接口
 */
export function useAttachment() {
  const { t } = useTranslation()
  const preview = async (path: string, title: string, fileType: string | null, extension?: string) => {
    try {
      if (fileType === FILE_TYPE.TEXT) {
        const content = await window.api.fs.readText(path)
        let ext = extension
        if (ext?.startsWith('.')) {
          ext = ext.replace('.', '')
        }
        void TextFilePreviewPopup.show(content, title, ext)
      } else {
        void window.api.file.openPath(path)
      }
    } catch (err) {
      logger.error(`Error opening ${path}:`, err as Error)
      window.modal.error({ content: t('files.preview.error'), centered: true })
    }
  }
  /**
   * Secure "open with default app" for media attachments behind the in-app
   * audio/video preview. Uses the narrow `openMediaAttachment` IPC (stored
   * `id + ext` or registered external path) — never the generic arbitrary
   * `openPath`. A Main rejection (including a non-empty `shell.openPath`
   * error string) surfaces the existing preview error.
   */
  const openWithDefaultApp = async (request: MediaAttachmentOpenRequest) => {
    try {
      await window.api.file.openMediaAttachment(request)
    } catch (err) {
      logger.error('Error opening media attachment with default app:', err as Error)
      window.modal.error({ content: t('files.preview.error'), centered: true })
    }
  }
  return {
    preview,
    openWithDefaultApp
  }
}
