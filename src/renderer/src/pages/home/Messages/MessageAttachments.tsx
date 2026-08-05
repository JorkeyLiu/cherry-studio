import { PaperClipOutlined } from '@ant-design/icons'
import { useAttachment } from '@renderer/hooks/useAttachment'
import FileManager from '@renderer/services/FileManager'
import type { FileMessageBlock } from '@renderer/types/newMessage'
import { parseFileTypes } from '@renderer/utils'
import { isBlockAttachmentUnavailable } from '@renderer/utils/attachmentAvailability'
import { Tooltip, Upload } from 'antd'
import { t } from 'i18next'
import type { FC } from 'react'
import styled from 'styled-components'

interface Props {
  block: FileMessageBlock
}

const StyledUpload = styled(Upload)`
  .ant-upload-list-item-name {
    max-width: 220px;
    display: inline-block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
    user-select: text;
  }
`

const MessageAttachments: FC<Props> = ({ block }) => {
  const { preview } = useAttachment()

  if (!block.file) {
    return null
  }

  // LOCK-UI-3: degraded imported file — stays visible with icon/name/type but
  // preview/open is disabled. No `file://` URL is built and no fs/openPath
  // IPC can be reached (no onPreview wiring).
  if (isBlockAttachmentUnavailable(block)) {
    const displayName = FileManager.formatFileName(block.file) || block.file.name || block.file.origin_name || ''
    const displayType = block.file.ext || block.file.type || ''
    const unavailableText = t('message.attachments.unavailable')

    return (
      <Container style={{ marginTop: 2, marginBottom: 8 }} className="message-attachments">
        <Tooltip title={unavailableText}>
          {/* Non-interactive status row: no interaction semantics (no
              aria-disabled on a plain element, no orphan listitem role) — the
              visible name/type/status text is the accessible name. */}
          <UnavailableItem data-testid="unavailable-file" title={unavailableText}>
            <PaperClipOutlined aria-hidden="true" />
            <UnavailableName title={displayName}>{displayName}</UnavailableName>
            {displayType && <UnavailableType>{displayType}</UnavailableType>}
            <UnavailableStatus>{unavailableText}</UnavailableStatus>
          </UnavailableItem>
        </Tooltip>
      </Container>
    )
  }

  return (
    <Container style={{ marginTop: 2, marginBottom: 8 }} className="message-attachments">
      <StyledUpload
        listType="text"
        disabled
        fileList={[
          {
            uid: block.file.id,
            url: 'file://' + FileManager.getSafePath(block.file),
            status: 'done' as const,
            name: FileManager.formatFileName(block.file),
            type: block.file.type ?? undefined,
            preview: block.file.ext
          }
        ]}
        onPreview={(file) => {
          if (file.url === undefined || file.type === undefined) {
            return
          }
          const fileType = parseFileTypes(file.type)
          if (fileType === null) {
            window.modal.error({ content: t('files.preview.error'), centered: true })
            return
          }
          let path = file.url
          if (path.startsWith('file://')) {
            path = path.replace('file://', '')
          }
          void preview(path, file.name, fileType, file.preview)
        }}
      />
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: row;
  gap: 10px;
  margin-top: 8px;
`

const UnavailableItem = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--color-border, rgba(128, 128, 128, 0.35));
  background-color: var(--color-background-mute, rgba(128, 128, 128, 0.06));
  color: var(--color-text-3, rgba(128, 128, 128, 0.85));
  user-select: none;
`

const UnavailableName = styled.span`
  max-width: 220px;
  display: inline-block;
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

export default MessageAttachments
