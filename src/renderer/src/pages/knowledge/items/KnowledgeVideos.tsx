import { DeleteOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import Ellipsis from '@renderer/components/Ellipsis'
import VideoPopup from '@renderer/components/Popups/VideoPopup'
import { DynamicVirtualList } from '@renderer/components/VirtualList'
import { useKnowledge } from '@renderer/hooks/useKnowledge'
import { getProviderName } from '@renderer/services/ProviderService'
import type { KnowledgeBase, KnowledgeItem } from '@renderer/types'
import { FILE_TYPE, isKnowledgeVideoItem } from '@renderer/types'
import { Button, Tooltip } from 'antd'
import dayjs from 'dayjs'
import { Plus } from 'lucide-react'
import type { FC } from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('KnowledgeVideos')

import FileItem from '@renderer/pages/files/FileItem'
import { formatFileSize } from '@renderer/utils'

import {
  KnowledgeSourceBody,
  KnowledgeSourceContent,
  KnowledgeSourceToolbar
} from '../components/KnowledgeSourceLayout'
import StatusIcon from '../components/StatusIcon'
import {
  ClickableSpan,
  FlexAlignCenter,
  KnowledgeEmptyView,
  RefreshIcon,
  ResponsiveButton,
  StatusIconWrapper
} from '../KnowledgeContent'

interface KnowledgeContentProps {
  selectedBase: KnowledgeBase
}

const getDisplayTime = (item: KnowledgeItem) => {
  const timestamp = item.updated_at && item.updated_at > item.created_at ? item.updated_at : item.created_at
  return dayjs(timestamp).format('MM-DD HH:mm')
}

const KnowledgeVideos: FC<KnowledgeContentProps> = ({ selectedBase }) => {
  const { t } = useTranslation()

  const { base, videoItems, refreshItem, removeItem, getProcessingStatus, addVideo } = useKnowledge(
    selectedBase.id || ''
  )

  const providerName = getProviderName(base?.model)
  const disabled = !base?.version || !providerName

  const estimateSize = useCallback(() => 75, [])

  if (!base) {
    return null
  }

  const handleAddVideo = async () => {
    if (disabled) {
      return
    }

    const result = await VideoPopup.show({
      title: t('knowledge.add_video')
    })
    if (!result) {
      return
    }

    if (result && result.videoFile && result.srtFile) {
      addVideo([result.videoFile, result.srtFile])
    }
  }

  return (
    <KnowledgeSourceBody>
      <KnowledgeSourceToolbar>
        <span />
        <ResponsiveButton
          type="primary"
          size="small"
          icon={<Plus size={14} />}
          onClick={(e) => {
            e.stopPropagation()
            void handleAddVideo()
          }}
          disabled={disabled}>
          {t('knowledge.add_video')}
        </ResponsiveButton>
      </KnowledgeSourceToolbar>
      <KnowledgeSourceContent>
        {videoItems.length === 0 ? (
          <KnowledgeEmptyView />
        ) : (
          <DynamicVirtualList
            list={[...videoItems].reverse()}
            estimateSize={estimateSize}
            overscan={2}
            scrollerStyle={{ flex: '1 1 auto', minHeight: 0, height: 'auto', padding: '16px 16px 16px 2px' }}
            itemContainerStyle={{ paddingBottom: 12 }}
            autoHideScrollbar>
            {(item) => {
              if (!isKnowledgeVideoItem(item)) {
                return null
              }
              const files = item.content
              const videoFile = files.find((f) => f.type === FILE_TYPE.VIDEO)

              if (!videoFile) {
                logger.warn('Knowledge item is missing video file data.', { itemId: item.id })
                return null
              }

              return (
                <FileItem
                  key={item.id}
                  fileInfo={{
                    name: (
                      <ClickableSpan onClick={() => window.api.file.openFileWithRelativePath(videoFile)}>
                        <Ellipsis>
                          <Tooltip title={videoFile.origin_name}>{videoFile.origin_name}</Tooltip>
                        </Ellipsis>
                      </ClickableSpan>
                    ),
                    ext: videoFile.ext,
                    extra: `${getDisplayTime(item)} · ${formatFileSize(videoFile.size)}`,
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
                          icon={<DeleteOutlined />}
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

export default KnowledgeVideos
