import { ExclamationCircleOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import { DeleteIcon, EditIcon } from '@renderer/components/Icons'
import db from '@renderer/databases'
import { getFileFieldLabel } from '@renderer/i18n/label'
import { handleDelete, handleRename, sortFiles, tempFilesSort } from '@renderer/services/FileAction'
import FileManager from '@renderer/services/FileManager'
import type { FileMetadata, FileType } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { formatFileSize } from '@renderer/utils'
import { Button, Checkbox, Empty, Flex, Input, Popconfirm, Spin } from 'antd'
import dayjs from 'dayjs'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  ArrowDownNarrowWide,
  ArrowUpWideNarrow,
  File as FileIcon,
  FileImage,
  FileText,
  FileType as FileTypeIcon,
  Search
} from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import FileList from './FileList'

type SortField = 'created_at' | 'size' | 'name'
type SortOrder = 'asc' | 'desc'

const logger = loggerService.withContext('FilesPage')

const FilesPage: FC = () => {
  const { t } = useTranslation()
  const [fileType, setFileType] = useState<FileType | 'all'>('document')
  const [sortField, setSortField] = useState<SortField>('created_at')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const [search, setSearch] = useState('')
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([])

  // Selection never outlives the rows it was made on: switching the category
  // filter or narrowing the search clears it instead of keeping invisible ids.
  useEffect(() => {
    setSelectedFileIds([])
  }, [fileType, search])

  const files = useLiveQuery<FileMetadata[]>(async () => {
    if (fileType === 'all') {
      return db.files.orderBy('count').toArray().then(tempFilesSort)
    }
    return db.files.where('type').equals(fileType).sortBy('count').then(tempFilesSort)
  }, [fileType])

  const sortedFiles = useMemo(
    () => (files ? sortFiles(files, sortField, sortOrder) : []),
    [files, sortField, sortOrder]
  )

  const visibleFiles = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) {
      return sortedFiles
    }
    return sortedFiles.filter((file) => {
      const displayName = FileManager.formatFileName(file)
      return displayName.toLowerCase().includes(query) || file.origin_name?.toLowerCase().includes(query)
    })
  }, [search, sortedFiles])

  const isImageTab = fileType === FILE_TYPE.IMAGE
  const selectable = !isImageTab

  const handleBatchDelete = async () => {
    await Promise.all(selectedFileIds.map((fileId) => handleDelete(fileId, t)))
    setSelectedFileIds([])
  }

  const handleSelectFile = (fileId: string, checked: boolean) => {
    if (checked) {
      setSelectedFileIds((prev) => (prev.includes(fileId) ? prev : [...prev, fileId]))
    } else {
      setSelectedFileIds((prev) => prev.filter((id) => id !== fileId))
    }
  }

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedFileIds(visibleFiles.map((file) => file.id))
    } else {
      setSelectedFileIds([])
    }
  }

  const rows = visibleFiles.map((file) => {
    logger.debug('FileItem', file)
    return {
      key: file.id,
      name: (
        <FileNameLink onClick={() => window.api.file.openPath(FileManager.getFilePath(file))}>
          {FileManager.formatFileName(file)}
        </FileNameLink>
      ),
      size: formatFileSize(file.size),
      count: file.count,
      created_at: file.created_at ? dayjs(file.created_at).format('MM-DD HH:mm') : '—',
      selected: selectedFileIds.includes(file.id),
      onSelect: selectable ? (checked: boolean) => handleSelectFile(file.id, checked) : undefined,
      actions: (
        <Flex align="center" gap={0} style={{ opacity: 0.7 }}>
          <Button
            type="text"
            size="small"
            data-testid="file-action-rename"
            icon={<EditIcon size={14} />}
            onClick={() => handleRename(file.id)}
          />
          <Popconfirm
            title={t('files.delete.title')}
            description={t('files.delete.content')}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
            onConfirm={() => handleDelete(file.id, t)}
            placement="left"
            icon={<ExclamationCircleOutlined style={{ color: 'red' }} />}>
            <Button
              type="text"
              size="small"
              danger
              data-testid="file-action-delete"
              icon={<DeleteIcon size={14} className="lucide-custom" />}
            />
          </Popconfirm>
        </Flex>
      )
    }
  })

  const categories = [
    { key: FILE_TYPE.DOCUMENT, label: t('files.document'), icon: <FileIcon size={14} /> },
    { key: FILE_TYPE.IMAGE, label: t('files.image'), icon: <FileImage size={14} /> },
    { key: FILE_TYPE.TEXT, label: t('files.text'), icon: <FileTypeIcon size={14} /> },
    { key: 'all', label: t('files.all'), icon: <FileText size={14} /> }
  ] as const

  const allVisibleSelected = visibleFiles.length > 0 && selectedFileIds.length === visibleFiles.length
  const someSelected = selectedFileIds.length > 0 && selectedFileIds.length < visibleFiles.length

  return (
    <Container data-testid="files-page">
      <Toolbar>
        <Flex align="center" gap={8} wrap="wrap" style={{ minWidth: 0 }}>
          <CategoryGroup role="group">
            {categories.map((item) => (
              <CategoryButton
                key={item.key}
                size="small"
                active={fileType === item.key}
                aria-pressed={fileType === item.key}
                icon={item.icon}
                onClick={() => setFileType(item.key)}>
                {item.label}
              </CategoryButton>
            ))}
          </CategoryGroup>
          <SearchInput
            allowClear
            size="small"
            value={search}
            placeholder={t('common.search')}
            prefix={<Search size={14} />}
            aria-label={t('common.search')}
            onChange={(e) => setSearch(e.target.value)}
          />
        </Flex>
        <Flex align="center" gap={8} wrap="wrap">
          <Flex align="center" gap={4}>
            {(['created_at', 'size', 'name'] as const).map((field) => (
              <SortButton
                key={field}
                size="small"
                active={sortField === field}
                onClick={() => {
                  if (sortField === field) {
                    setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
                  } else {
                    setSortField(field)
                    setSortOrder('desc')
                  }
                }}>
                {getFileFieldLabel(field)}
                {sortField === field &&
                  (sortOrder === 'desc' ? <ArrowUpWideNarrow size={12} /> : <ArrowDownNarrowWide size={12} />)}
              </SortButton>
            ))}
          </Flex>
          {selectable && (
            <Flex align="center" gap={8}>
              <Checkbox
                checked={allVisibleSelected}
                indeterminate={someSelected}
                disabled={visibleFiles.length === 0}
                onChange={(e) => handleSelectAll(e.target.checked)}>
                {t('files.batch_operation')}
              </Checkbox>
              <Popconfirm
                title={t('files.delete.title')}
                description={t('files.delete.content')}
                okText={t('common.confirm')}
                cancelText={t('common.cancel')}
                onConfirm={handleBatchDelete}
                placement="bottom"
                icon={<ExclamationCircleOutlined style={{ color: 'red' }} />}>
                <Button
                  size="small"
                  danger
                  disabled={selectedFileIds.length === 0}
                  data-testid="files-batch-delete"
                  icon={<DeleteIcon size={14} className="lucide-custom" />}>
                  {`${t('files.batch_delete')}${selectedFileIds.length > 0 ? ` (${selectedFileIds.length})` : ''}`}
                </Button>
              </Popconfirm>
            </Flex>
          )}
        </Flex>
      </Toolbar>
      <ListArea>
        {files === undefined ? (
          <StateWrapper data-testid="files-loading">
            <Spin />
          </StateWrapper>
        ) : visibleFiles.length === 0 ? (
          <StateWrapper data-testid="files-empty">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('common.no_results')} />
          </StateWrapper>
        ) : (
          <FileList id={fileType} list={rows} files={visibleFiles} selectable={selectable} />
        )}
      </ListArea>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: var(--color-background);
`

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 0.5px solid var(--color-border);
  flex-shrink: 0;
`

const CategoryGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 0.5px solid var(--color-border);
  border-radius: var(--list-item-border-radius);
`

const CategoryButton = styled(Button)<{ active?: boolean }>`
  display: flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 8px;
  border-radius: var(--list-item-border-radius);
  border: 0.5px solid ${(props) => (props.active ? 'var(--color-border)' : 'transparent')};
  background-color: ${(props) => (props.active ? 'var(--color-background-soft)' : 'transparent')};
  color: ${(props) => (props.active ? 'var(--color-primary)' : 'var(--color-text-secondary)')};

  &:hover {
    background-color: var(--color-background-soft) !important;
    color: var(--color-text) !important;
  }
`

const SearchInput = styled(Input)`
  width: 190px;
  max-width: 100%;
  border-radius: var(--list-item-border-radius);
`

const SortButton = styled(Button)<{ active?: boolean }>`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  height: 26px;
  border-radius: var(--list-item-border-radius);
  border: 0.5px solid ${(props) => (props.active ? 'var(--color-border)' : 'transparent')};
  background-color: ${(props) => (props.active ? 'var(--color-background-soft)' : 'transparent')};
  color: ${(props) => (props.active ? 'var(--color-text)' : 'var(--color-text-secondary)')};

  &:hover {
    background-color: var(--color-background-soft);
    color: var(--color-text);
  }

  .anticon {
    font-size: 12px;
  }
`

const ListArea = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
`

const StateWrapper = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 0;
  padding: 24px;
`

const FileNameLink = styled.span`
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;

  &:hover {
    color: var(--color-primary);
  }
`

export default FilesPage
