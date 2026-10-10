import FileManager from '@renderer/services/FileManager'
import { loggerService } from '@renderer/services/LoggerService'
import type { FileMetadata } from '@renderer/types'
import type { VideoMessageBlock } from '@renderer/types/newMessage'
import { toMediaFileUrl } from '@renderer/utils/mediaAttachment'
import type { FC } from 'react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import ReactPlayer from 'react-player'
import styled from 'styled-components'

const logger = loggerService.withContext('MessageVideo')

/**
 * Receiver-side local file DTO carried on synced file-backed VIDEO blocks.
 *
 * Main `mediaReadAssembly` hydrates `overflow.file` (plus `overflow.filePath`)
 * for portable `video` blocks from trusted `file_references` + `sync_file_asset`
 * rows, and the wire spreads overflow keys to the top level — so a synced
 * receiver observes `block.file` at runtime although `VideoMessageBlock` does
 * not declare it. This alias consumes that fact without widening the shared
 * type, the capture entry, or the wire protocol; no field is guessed and no
 * sender path/metadata is synthesized.
 */
type VideoBlockWithLocalFile = VideoMessageBlock & {
  file?: FileMetadata | null
}

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.length > 0
}

const getMetadataVideoPath = (block: VideoMessageBlock): string | null => {
  const path = (block.metadata as { video?: { path?: unknown } } | undefined)?.video?.path
  return isNonEmptyString(path) ? path : null
}

const getLocalFileDto = (block: VideoMessageBlock): FileMetadata | null => {
  const file = (block as VideoBlockWithLocalFile).file
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    return null
  }
  return file
}

/**
 * Resolve the local `file://` source, preserving the legacy
 * `metadata.video.path` behavior first and falling back to the synced
 * receiver DTO (`block.file` via `FileManager.getSafePath`) and then to the
 * plain `filePath`. Returns `null` when no usable local source exists so
 * callers render the missing-file fallback and never emit `file://undefined`.
 */
const resolveLocalVideoSrc = (block: VideoMessageBlock): string | null => {
  const metadataPath = getMetadataVideoPath(block)
  if (metadataPath !== null) {
    return toMediaFileUrl(metadataPath)
  }
  const file = getLocalFileDto(block)
  if (file !== null) {
    try {
      const src = toMediaFileUrl(FileManager.getSafePath(file))
      if (src !== null) {
        return src
      }
    } catch {
      // Fall through to the plain filePath below.
    }
  }
  if (isNonEmptyString(block.filePath)) {
    return toMediaFileUrl(block.filePath)
  }
  return null
}

interface Props {
  block: VideoMessageBlock
}

const MessageVideo: FC<Props> = ({ block }) => {
  const playerRef = useRef<HTMLVideoElement | null>(null)
  const { t } = useTranslation()

  logger.debug(`MessageVideo: ${JSON.stringify(block)}`)

  const hasRemoteUrl = isNonEmptyString(block.url)
  const hasLocalSource =
    getMetadataVideoPath(block) !== null || getLocalFileDto(block) !== null || isNonEmptyString(block.filePath)

  if (!hasRemoteUrl && !hasLocalSource) {
    return null
  }

  /**
   * 渲染本地视频文件
   */
  const renderLocalVideo = () => {
    const videoSrc = resolveLocalVideoSrc(block)
    if (!videoSrc) {
      logger.warn('Local video was requested but no usable local source was found.')
      return <div>{t('message.video.error.local_file_missing')}</div>
    }

    const handleReady = () => {
      const startTime = Math.floor(block.metadata?.startTime ?? 0)
      if (playerRef.current) {
        playerRef.current.currentTime = startTime
      }
    }

    return (
      <ReactPlayer
        ref={playerRef}
        style={{
          height: '100%',
          width: '100%'
        }}
        src={videoSrc}
        controls
        onReady={handleReady}
      />
    )
  }

  const renderVideo = () => {
    // Remote/generated video keeps its original URL semantics: no file:// wrapping.
    if (hasRemoteUrl) {
      return (
        <ReactPlayer
          ref={playerRef}
          style={{
            height: '100%',
            width: '100%'
          }}
          src={block.url}
          controls
        />
      )
    }

    switch (block.metadata?.type) {
      case 'video':
        return renderLocalVideo()

      default:
        // Synced file-backed VIDEO carries no metadata: fall back to the local
        // receiver DTO/filePath instead of reporting unsupported.
        if (hasLocalSource) {
          logger.warn(
            `Unknown video type: ${block.metadata?.type}, but with a local source will try to render as local video.`
          )
          return renderLocalVideo()
        }

        logger.warn(`Unsupported video type: ${block.metadata?.type} or missing necessary data.`)
        return <div>{t('message.video.error.unsupported_type')}</div>
    }
  }

  return <Container>{renderVideo()}</Container>
}

export default MessageVideo

const Container = styled.div`
  max-width: 560px;
  width: 100%;
  aspect-ratio: 16 / 9;
  height: auto;
  background-color: #000;
`
