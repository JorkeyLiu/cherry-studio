import { FileUnknownFilled } from '@ant-design/icons'
import FileManager from '@renderer/services/FileManager'
import type { FileMetadata } from '@renderer/types'
import { formatFileSize } from '@renderer/utils'
import { getMediaKind, isInAppPlayable } from '@renderer/utils/mediaAttachment'
import { Button } from 'antd'
import type { FC, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface MediaAttachmentPreviewProps {
  file: FileMetadata
  /**
   * Centralized `file://` URL (see `toMediaFileUrl`). `null` when the source
   * path is missing — the fallback card renders and no `file://` URL or IPC
   * is ever produced from here.
   */
  src: string | null
  /** Leading icon; callers pass the house `getFileIcon(file.ext)` result. */
  icon?: ReactNode
  /** Secure "open with default app" action (narrow IPC, never whole-card). */
  onOpenWithDefaultApp: () => void
  /** True when no usable open identity exists — the action stays disabled. */
  defaultAppDisabled?: boolean
}

/**
 * Reusable in-app audio/video attachment preview.
 *
 * Main preview is a native HTML5 `<audio>` / `<video>` element (controls,
 * `preload="metadata"`, never autoplay). Formats the browser cannot decode
 * — or attachments without a usable source — render the generic media card
 * with the explicit secondary "open with default app" action instead of
 * jumping out on card click. Shared by the pre-send `AttachmentPreview` and
 * the sent `MessageAttachments`.
 */
const MediaAttachmentPreview: FC<MediaAttachmentPreviewProps> = ({
  file,
  src,
  icon,
  onOpenWithDefaultApp,
  defaultAppDisabled = false
}) => {
  const { t } = useTranslation()
  const kind = getMediaKind(file)
  const playable = isInAppPlayable(file) && src !== null
  const fullName = FileManager.formatFileName(file)
  const openLabel = t('message.attachments.open_with_default_app')
  const playerLabel = t('message.attachments.media_player_label', { name: fullName })

  return (
    <MediaContainer data-testid="media-attachment">
      <MediaHeader>
        <MediaIcon aria-hidden="true">{icon ?? <FileUnknownFilled />}</MediaIcon>
        <MediaName title={fullName}>{fullName}</MediaName>
        {file.ext && <MediaExt>{file.ext}</MediaExt>}
        <MediaSize>{formatFileSize(file.size)}</MediaSize>
      </MediaHeader>
      {playable && kind === 'audio' && (
        <StyledAudio data-testid="media-audio" controls preload="metadata" src={src} aria-label={playerLabel} />
      )}
      {playable && kind === 'video' && (
        <StyledVideo
          data-testid="media-video"
          controls
          preload="metadata"
          playsInline
          src={src}
          aria-label={playerLabel}
        />
      )}
      {!playable && (
        <MediaFallback data-testid="media-fallback">
          {t('message.attachments.media_unsupported_format', { format: file.ext || file.type || '' })}
        </MediaFallback>
      )}
      <Button
        data-testid="media-open-default"
        size="small"
        type="default"
        onClick={onOpenWithDefaultApp}
        disabled={defaultAppDisabled}
        title={openLabel}
        aria-label={openLabel}>
        {openLabel}
      </Button>
    </MediaContainer>
  )
}

const MediaContainer = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  max-width: 340px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--color-border, rgba(128, 128, 128, 0.35));
  background-color: var(--color-background-soft, rgba(128, 128, 128, 0.04));
`

const MediaHeader = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  max-width: 100%;
`

const MediaIcon = styled.span`
  display: inline-flex;
  align-items: center;
  font-size: 16px;
`

const MediaName = styled.span`
  max-width: 180px;
  display: inline-block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  user-select: text;
`

const MediaExt = styled.span`
  font-size: 11px;
  color: var(--color-text-3, rgba(128, 128, 128, 0.7));
`

const MediaSize = styled.span`
  font-size: 11px;
  color: var(--color-text-3, rgba(128, 128, 128, 0.7));
`

const StyledAudio = styled.audio`
  width: 100%;
  max-width: 320px;
  min-height: 32px;
`

const StyledVideo = styled.video`
  width: 100%;
  max-width: 320px;
  max-height: 240px;
  border-radius: 6px;
  background-color: #000;
`

const MediaFallback = styled.div`
  font-size: 12px;
  color: var(--color-text-2, rgba(128, 128, 128, 0.9));
`

export default MediaAttachmentPreview
