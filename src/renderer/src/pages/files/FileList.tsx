import { ExclamationCircleOutlined } from '@ant-design/icons'
import { DeleteIcon } from '@renderer/components/Icons'
import { DynamicVirtualList } from '@renderer/components/VirtualList'
import { handleDelete } from '@renderer/services/FileAction'
import FileManager from '@renderer/services/FileManager'
import type { FileMetadata, FileType } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { formatFileSize } from '@renderer/utils'
import { Checkbox, Image, Spin } from 'antd'
import React, { memo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

export interface FileRow {
  key: string
  name: React.ReactNode
  size: string
  count?: number
  created_at: string
  selected: boolean
  onSelect?: (checked: boolean) => void
  actions: React.ReactNode
}

interface FileListProps {
  id: FileType | 'all' | string
  list: FileRow[]
  files?: FileMetadata[]
  selectable?: boolean
}

const FileList: React.FC<FileListProps> = ({ id, list, files, selectable = true }) => {
  const { t } = useTranslation()
  const estimateSize = useCallback(() => 48, [])

  if (id === FILE_TYPE.IMAGE && files?.length && files?.length > 0) {
    return (
      <ImageGrid>
        <Image.PreviewGroup>
          <GridRow>
            {files.map((file) => (
              <ImageWrapper key={file.id}>
                <LoadingWrapper>
                  <Spin />
                </LoadingWrapper>
                <Image
                  src={FileManager.getFileUrl(file)}
                  style={{ height: '100%', objectFit: 'cover', cursor: 'pointer' }}
                  preview={{ mask: false }}
                  onLoad={(e) => {
                    const img = e.target as HTMLImageElement
                    img.parentElement?.classList.add('loaded')
                  }}
                />
                <ImageInfo>
                  <div>{formatFileSize(file.size)}</div>
                </ImageInfo>
                <DeleteButton
                  title={t('files.delete.title')}
                  onClick={(e) => {
                    e.stopPropagation()
                    window.modal.confirm({
                      title: t('files.delete.title'),
                      content: t('files.delete.content'),
                      okText: t('common.confirm'),
                      cancelText: t('common.cancel'),
                      centered: true,
                      onOk: () => {
                        void handleDelete(file.id, t)
                      },
                      icon: <ExclamationCircleOutlined style={{ color: 'red' }} />
                    })
                  }}>
                  <DeleteIcon size={14} className="lucide-custom" />
                </DeleteButton>
              </ImageWrapper>
            ))}
          </GridRow>
        </Image.PreviewGroup>
      </ImageGrid>
    )
  }

  return (
    <ListColumn>
      <HeaderRow $selectable={selectable} data-testid="files-header-row">
        <div />
        <HeaderCell>{t('files.name')}</HeaderCell>
        <HeaderCell>{t('files.size')}</HeaderCell>
        <HeaderCell>{t('files.count')}</HeaderCell>
        <HeaderCell>{t('files.created_at')}</HeaderCell>
        <HeaderCell>{t('files.actions')}</HeaderCell>
      </HeaderRow>
      <DynamicVirtualList
        list={list}
        estimateSize={estimateSize}
        overscan={4}
        autoHideScrollbar
        scrollerStyle={{
          flex: 1,
          minHeight: 0,
          height: 'auto',
          padding: '0 16px 16px 16px'
        }}>
        {(item: FileRow) => (
          <Row $selectable={selectable} data-testid="file-row" data-row-key={item.key} $selected={item.selected}>
            <CheckboxCell>
              {selectable && item.onSelect ? (
                <Checkbox
                  checked={item.selected}
                  aria-label={t('common.select')}
                  data-testid="file-row-select"
                  onChange={(e) => item.onSelect?.(e.target.checked)}
                />
              ) : null}
            </CheckboxCell>
            <NameCell>{item.name}</NameCell>
            <MetaCell>{item.size}</MetaCell>
            <MetaCell>{item.count}</MetaCell>
            <MetaCell>{item.created_at}</MetaCell>
            <ActionsCell>{item.actions}</ActionsCell>
          </Row>
        )}
      </DynamicVirtualList>
    </ListColumn>
  )
}

const columnTemplate = (selectable: boolean) =>
  selectable ? '32px minmax(0, 1fr) 90px 70px 110px 88px' : 'minmax(0, 1fr) 90px 70px 110px 88px'

const ListColumn = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
`

const HeaderRow = styled.div<{ $selectable: boolean }>`
  display: grid;
  grid-template-columns: ${(props) => columnTemplate(props.$selectable)};
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  flex-shrink: 0;
  border-bottom: 0.5px solid var(--color-border);
`

const Row = styled.div<{ $selectable: boolean; $selected: boolean }>`
  display: grid;
  grid-template-columns: ${(props) => columnTemplate(props.$selectable)};
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 16px;
  border-bottom: 0.5px solid var(--color-border);
  background-color: ${(props) => (props.$selected ? 'var(--color-background-soft)' : 'transparent')};

  &:hover {
    background-color: var(--color-background-soft);
  }
`

const HeaderCell = styled.div`
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const CheckboxCell = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
`

const NameCell = styled.div`
  min-width: 0;
  overflow: hidden;
`

const MetaCell = styled.div`
  font-size: 12px;
  color: var(--color-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const ActionsCell = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
`

const ImageGrid = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
`

const GridRow = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 16px;
`

const ImageWrapper = styled.div`
  position: relative;
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: 8px;
  background-color: var(--color-background-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0.5px solid var(--color-border);

  .ant-image {
    height: 100%;
    width: 100%;
    opacity: 0;
    transition:
      opacity 0.3s ease,
      transform 0.3s ease;

    &.loaded {
      opacity: 1;
    }
  }

  &:hover {
    .ant-image.loaded {
      transform: scale(1.05);
    }

    div:last-child {
      opacity: 1;
    }
  }
`

const LoadingWrapper = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--color-background-soft);
`

const ImageInfo = styled.div`
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(0, 0, 0, 0.6);
  color: white;
  padding: 5px 8px;
  opacity: 0;
  transition: opacity 0.3s ease;
  font-size: 12px;

  > div:first-child {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
`

const DeleteButton = styled.div`
  position: absolute;
  top: 8px;
  right: 8px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background-color: rgba(0, 0, 0, 0.6);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.3s ease;
  z-index: 1;

  &:hover {
    background-color: rgba(255, 0, 0, 0.8);
  }
`

export default memo(FileList)
