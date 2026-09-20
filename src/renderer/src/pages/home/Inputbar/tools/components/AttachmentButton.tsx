import { ActionIconButton } from '@renderer/components/Buttons'
import type { FileMetadata } from '@renderer/types'
import { filterSupportedFiles } from '@renderer/utils/file'
import { Tooltip } from 'antd'
import { Paperclip } from 'lucide-react'
import type { Dispatch, FC, SetStateAction } from 'react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  couldAddImageFile: boolean
  extensions: string[]
  files: FileMetadata[]
  setFiles: Dispatch<SetStateAction<FileMetadata[]>>
  disabled?: boolean
}

const AttachmentButton: FC<Props> = ({ couldAddImageFile, extensions, files, setFiles, disabled }) => {
  const { t } = useTranslation()
  const [selecting, setSelecting] = useState<boolean>(false)

  const openFileSelectDialog = useCallback(async () => {
    if (selecting) return
    const useAllFiles = extensions.length > 20
    setSelecting(true)
    const _files = await window.api.file.select({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Files', extensions: useAllFiles ? ['*'] : extensions.map((i) => i.replace('.', '')) }]
    })
    setSelecting(false)
    if (_files) {
      if (!useAllFiles) {
        setFiles([...files, ..._files])
        return
      }
      const supportedFiles = await filterSupportedFiles(_files, extensions)
      if (supportedFiles.length > 0) setFiles([...files, ...supportedFiles])
      if (supportedFiles.length !== _files.length) {
        window.toast.info(t('chat.input.file_not_supported_count', { count: _files.length - supportedFiles.length }))
      }
    }
  }, [extensions, files, selecting, setFiles, t])

  const ariaLabel = couldAddImageFile ? t('chat.input.upload.image_or_document') : t('chat.input.upload.document')

  return (
    <Tooltip placement="top" title={ariaLabel} mouseLeaveDelay={0} arrow>
      <ActionIconButton
        onClick={openFileSelectDialog}
        active={files.length > 0}
        disabled={disabled}
        aria-label={ariaLabel}>
        <Paperclip size={18} />
      </ActionIconButton>
    </Tooltip>
  )
}

export default AttachmentButton
