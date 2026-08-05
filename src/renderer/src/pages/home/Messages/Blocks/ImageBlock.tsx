import { PictureOutlined } from '@ant-design/icons'
import ImageViewer from '@renderer/components/ImageViewer'
import FileManager from '@renderer/services/FileManager'
import { type ImageMessageBlock, MessageBlockStatus } from '@renderer/types/newMessage'
import { isBlockAttachmentUnavailable } from '@renderer/utils/attachmentAvailability'
import { Skeleton } from 'antd'
import React from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  block: ImageMessageBlock
  isSingle?: boolean
}

const ImageBlock: React.FC<Props> = ({ block, isSingle = false }) => {
  if (block.status === MessageBlockStatus.PENDING) {
    return <Skeleton.Image active style={{ width: 200, height: 200 }} />
  }

  // LOCK-UI-2: degraded imported image — stable placeholder, retained
  // filename/type, localized unavailable state. Never mounts ImageViewer /
  // AntImage and never calls getFilePath / getImageSize.
  if (isBlockAttachmentUnavailable(block)) {
    return <ImageUnavailablePlaceholder block={block} isSingle={isSingle} />
  }

  if (block.status === MessageBlockStatus.STREAMING || block.status === MessageBlockStatus.SUCCESS) {
    const images = block.metadata?.generateImageResponse?.images?.length
      ? block.metadata?.generateImageResponse?.images
      : block?.file
        ? [`file://${FileManager.getFilePath(block?.file)}`]
        : block?.url
          ? [block.url]
          : []

    return (
      <Container>
        {images.map((src, index) => (
          <ImageViewer
            src={src}
            key={`image-${index}`}
            style={
              isSingle
                ? { maxWidth: 500, maxHeight: 'min(500px, 50vh)', padding: 0, borderRadius: 8 }
                : { width: 280, height: 280, objectFit: 'cover', padding: 0, borderRadius: 8 }
            }
          />
        ))}
      </Container>
    )
  }

  return null
}

const ImageUnavailablePlaceholder: React.FC<Props> = ({ block, isSingle }) => {
  const { t } = useTranslation()
  const file = block.file
  const displayName = file ? FileManager.formatFileName(file) || file.name || file.origin_name || '' : ''
  const displayType = file ? file.ext || file.type || '' : ''
  const unavailableText = t('message.attachments.unavailable')

  return (
    <UnavailableImage
      data-testid="unavailable-image"
      role="img"
      title={unavailableText}
      aria-label={displayName ? `${unavailableText}: ${displayName}` : unavailableText}
      $isSingle={isSingle ?? false}>
      <PictureOutlined className="unavailable-icon" aria-hidden="true" />
      {displayName && <UnavailableName title={displayName}>{displayName}</UnavailableName>}
      {displayType && <UnavailableType>{displayType}</UnavailableType>}
      <UnavailableStatus>{unavailableText}</UnavailableStatus>
    </UnavailableImage>
  )
}

const Container = styled.div`
  display: block;
`

const UnavailableImage = styled.div<{ $isSingle: boolean }>`
  width: 280px;
  height: 280px;
  ${({ $isSingle }) => ($isSingle ? 'max-width: 100%;' : '')}
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 12px;
  box-sizing: border-box;
  border-radius: 8px;
  border: 1px dashed var(--color-border, rgba(128, 128, 128, 0.35));
  background-color: var(--color-background-mute, rgba(128, 128, 128, 0.06));
  color: var(--color-text-3, rgba(128, 128, 128, 0.85));
  user-select: none;

  .unavailable-icon {
    font-size: 36px;
    margin-bottom: 4px;
  }
`

const UnavailableName = styled.span`
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--color-text-2, rgba(128, 128, 128, 0.9));
`

const UnavailableType = styled.span`
  font-size: 11px;
  color: var(--color-text-3, rgba(128, 128, 128, 0.7));
`

const UnavailableStatus = styled.span`
  font-size: 11px;
  color: var(--color-text-3, rgba(128, 128, 128, 0.7));
`

export default React.memo(ImageBlock)
