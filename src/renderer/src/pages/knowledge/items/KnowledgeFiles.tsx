import { loggerService } from '@logger'
import Ellipsis from '@renderer/components/Ellipsis'
import { DeleteIcon } from '@renderer/components/Icons'
import { DynamicVirtualList } from '@renderer/components/VirtualList'
import { useFiles } from '@renderer/hooks/useFiles'
import { useKnowledge } from '@renderer/hooks/useKnowledge'
import FileItem from '@renderer/pages/files/FileItem'
import StatusIcon from '@renderer/pages/knowledge/components/StatusIcon'
import FileManager from '@renderer/services/FileManager'
import { getProviderName } from '@renderer/services/ProviderService'
import type { FileMetadata, KnowledgeBase, KnowledgeItem } from '@renderer/types'
import { isKnowledgeFileItem } from '@renderer/types'
import { formatFileSize, mime2type, uuid } from '@renderer/utils'
import { bookExts, documentExts, textExts, thirdPartyApplicationExts } from '@shared/config/constant'
import { Button, Tooltip, Upload } from 'antd'
import dayjs from 'dayjs'
import { PlusIcon } from 'lucide-react'
import type { FC } from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import {
  KnowledgeSourceBody,
  KnowledgeSourceContent,
  KnowledgeSourceDropPad,
  KnowledgeSourceToolbar
} from '../components/KnowledgeSourceLayout'
import {
  ClickableSpan,
  FlexAlignCenter,
  KnowledgeEmptyView,
  RefreshIcon,
  ResponsiveButton,
  StatusIconWrapper
} from '../KnowledgeContent'

const logger = loggerService.withContext('KnowledgeFiles')
const { Dragger } = Upload

interface KnowledgeContentProps {
  selectedBase: KnowledgeBase
}

const fileTypes = [...bookExts, ...thirdPartyApplicationExts, ...documentExts, ...textExts]

const getDisplayTime = (item: KnowledgeItem) => {
  const timestamp = item.updated_at && item.updated_at > item.created_at ? item.updated_at : item.created_at
  return dayjs(timestamp).format('MM-DD HH:mm')
}

const KnowledgeFiles: FC<KnowledgeContentProps> = ({ selectedBase }) => {
  const { t } = useTranslation()
  const { onSelectFile, selecting } = useFiles({ extensions: fileTypes })

  const { base, fileItems, addFiles, refreshItem, removeItem, getProcessingStatus } = useKnowledge(
    selectedBase.id || ''
  )

  const providerName = getProviderName(base?.model)
  const disabled = !base?.version || !providerName

  const estimateSize = useCallback(() => 75, [])

  if (!base) {
    return null
  }

  const handleAddFile = async () => {
    if (disabled || selecting) {
      return
    }
    const selectedFiles = await onSelectFile({ multipleSelections: true })
    void processFiles(selectedFiles)
  }

  const handleDrop = async (files: File[]) => {
    if (disabled) {
      return
    }
    if (files) {
      const _files: FileMetadata[] = files
        .map((file) => {
          // 这个路径 filePath 很可能是在文件选择时的原始路径。
          const filePath = window.api.file.getPathForFile(file)
          let nameFromPath = filePath
          const lastSlash = filePath.lastIndexOf('/')
          const lastBackslash = filePath.lastIndexOf('\\')
          if (lastSlash !== -1 || lastBackslash !== -1) {
            nameFromPath = filePath.substring(Math.max(lastSlash, lastBackslash) + 1)
          }

          // 从派生的文件名中获取扩展名
          const extFromPath = nameFromPath.includes('.') ? `.${nameFromPath.split('.').pop()}` : ''

          return {
            id: uuid(),
            name: nameFromPath, // 使用从路径派生的文件名
            path: filePath,
            size: file.size,
            ext: extFromPath.toLowerCase(),
            count: 1,
            origin_name: file.name, // 保存 File 对象中原始的文件名
            type: mime2type(file.type),
            created_at: new Date().toISOString()
          }
        })
        .filter(({ ext }) => fileTypes.includes(ext))
      void processFiles(_files)
    }
  }

  const processFiles = async (files: FileMetadata[]) => {
    logger.debug('processFiles', files)
    if (files.length > 0) {
      const uploadedFiles = await FileManager.uploadFiles(files)
      addFiles(uploadedFiles)
    }
  }

  return (
    <KnowledgeSourceBody>
      <KnowledgeSourceToolbar>
        <span>{t('knowledge.drag_file')}</span>
        <ResponsiveButton
          type="primary"
          size="small"
          icon={<PlusIcon size={14} />}
          onClick={(e) => {
            e.stopPropagation()
            void handleAddFile()
          }}
          disabled={disabled}>
          {t('knowledge.add_file')}
        </ResponsiveButton>
      </KnowledgeSourceToolbar>
      <KnowledgeSourceDropPad>
        <div
          onClick={(e) => {
            e.stopPropagation()
            void handleAddFile()
          }}>
          <Dragger
            showUploadList={false}
            customRequest={({ file }) => handleDrop([file as File])}
            multiple={true}
            accept={fileTypes.join(',')}
            openFileDialogOnClick={false}>
            <p className="ant-upload-text">{t('knowledge.drag_file')}</p>
            <p className="ant-upload-hint">
              {t('knowledge.file_hint', { file_types: 'TXT, MD, HTML, PDF, DOCX, PPTX, XLSX, EPUB...' })}
            </p>
          </Dragger>
        </div>
      </KnowledgeSourceDropPad>
      <KnowledgeSourceContent>
        {fileItems.length === 0 ? (
          <KnowledgeEmptyView />
        ) : (
          <DynamicVirtualList
            list={fileItems.reverse()}
            estimateSize={estimateSize}
            overscan={2}
            scrollerStyle={{ flex: '1 1 auto', minHeight: 0, height: 'auto', padding: '12px 16px 16px 2px' }}
            itemContainerStyle={{ paddingBottom: 10 }}
            autoHideScrollbar>
            {(item) => {
              if (!isKnowledgeFileItem(item)) {
                return null
              }
              const file = item.content
              return (
                <FileItem
                  key={item.id}
                  fileInfo={{
                    name: (
                      <ClickableSpan onClick={() => window.api.file.openFileWithRelativePath(file)}>
                        <Ellipsis>
                          <Tooltip title={file.origin_name}>{file.origin_name}</Tooltip>
                        </Ellipsis>
                      </ClickableSpan>
                    ),
                    ext: file.ext,
                    extra: `${getDisplayTime(item)} · ${formatFileSize(file.size)}`,
                    actions: (
                      <FlexAlignCenter>
                        {item.uniqueId && (
                          <Button type="text" size="small" icon={<RefreshIcon />} onClick={() => refreshItem(item)} />
                        )}
                        <StatusIconWrapper>
                          <StatusIcon
                            sourceId={item.id}
                            base={base}
                            getProcessingStatus={getProcessingStatus}
                            type="file"
                          />
                        </StatusIconWrapper>
                        <Button
                          type="text"
                          size="small"
                          danger
                          onClick={() => removeItem(item)}
                          icon={<DeleteIcon size={14} className="lucide-custom" />}
                        />
                      </FlexAlignCenter>
                    )
                  }}
                />
              )
            }}
          </DynamicVirtualList>
        )}
      </KnowledgeSourceContent>
    </KnowledgeSourceBody>
  )
}

export default KnowledgeFiles
