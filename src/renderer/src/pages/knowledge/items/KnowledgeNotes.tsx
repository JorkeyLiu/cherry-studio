import { DeleteIcon, EditIcon } from '@renderer/components/Icons'
import RichEditPopup from '@renderer/components/Popups/RichEditPopup'
import { DynamicVirtualList } from '@renderer/components/VirtualList'
import { useKnowledge } from '@renderer/hooks/useKnowledge'
import FileItem from '@renderer/pages/files/FileItem'
import { getProviderName } from '@renderer/services/ProviderService'
import type { KnowledgeBase, KnowledgeItem } from '@renderer/types'
import { isMarkdownContent, markdownToPreviewText } from '@renderer/utils/markdownConverter'
import { Button } from 'antd'
import dayjs from 'dayjs'
import { PlusIcon } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import {
  KnowledgeSourceBody,
  KnowledgeSourceContent,
  KnowledgeSourceToolbar
} from '../components/KnowledgeSourceLayout'
import StatusIcon from '../components/StatusIcon'
import { FlexAlignCenter, KnowledgeEmptyView, ResponsiveButton, StatusIconWrapper } from '../KnowledgeContent'

interface KnowledgeContentProps {
  selectedBase: KnowledgeBase
}

const getDisplayTime = (item: KnowledgeItem) => {
  const timestamp = item.updated_at && item.updated_at > item.created_at ? item.updated_at : item.created_at
  return dayjs(timestamp).format('MM-DD HH:mm')
}

const KnowledgeNotes: FC<KnowledgeContentProps> = ({ selectedBase }) => {
  const { t } = useTranslation()

  const { base, noteItems, updateNoteContent, removeItem, getProcessingStatus, addNote } = useKnowledge(
    selectedBase.id || ''
  )

  const providerName = getProviderName(base?.model)
  const disabled = !base?.version || !providerName

  const reversedItems = useMemo(() => [...noteItems].reverse(), [noteItems])
  const estimateSize = useCallback(() => 75, [])

  if (!base) {
    return null
  }

  const handleAddNote = async () => {
    if (disabled) {
      return
    }

    const note = await RichEditPopup.show({
      content: '',
      modalProps: {
        title: t('knowledge.add_note')
      }
    })
    note && addNote(note)
  }

  const handleEditNote = async (note: any) => {
    if (disabled) {
      return
    }

    const editedText = await RichEditPopup.show({
      content: note.content as string,
      modalProps: {
        title: t('common.edit')
      }
    })
    editedText && updateNoteContent(note.id, editedText)
  }

  return (
    <KnowledgeSourceBody>
      <KnowledgeSourceToolbar>
        <span />
        <ResponsiveButton
          type="primary"
          size="small"
          icon={<PlusIcon size={14} />}
          onClick={(e) => {
            e.stopPropagation()
            void handleAddNote()
          }}
          disabled={disabled}>
          {t('knowledge.add_note')}
        </ResponsiveButton>
      </KnowledgeSourceToolbar>
      <KnowledgeSourceContent>
        {noteItems.length === 0 ? (
          <KnowledgeEmptyView />
        ) : (
          <DynamicVirtualList
            list={reversedItems}
            estimateSize={estimateSize}
            overscan={2}
            scrollerStyle={{ flex: '1 1 auto', minHeight: 0, height: 'auto', padding: '16px 16px 16px 2px' }}
            itemContainerStyle={{ paddingBottom: 10 }}
            autoHideScrollbar>
            {(note) => (
              <FileItem
                key={note.id}
                fileInfo={{
                  name: (
                    <NotePreview onClick={() => handleEditNote(note)}>
                      {markdownToPreviewText(note.content as string, 50)}
                    </NotePreview>
                  ),
                  ext: isMarkdownContent(note.content as string) ? '.md' : '.txt',
                  extra: getDisplayTime(note),
                  actions: (
                    <FlexAlignCenter>
                      <Button
                        type="text"
                        size="small"
                        onClick={() => handleEditNote(note)}
                        icon={<EditIcon size={14} />}
                      />
                      <StatusIconWrapper>
                        <StatusIcon
                          sourceId={note.id}
                          base={base}
                          getProcessingStatus={getProcessingStatus}
                          type="note"
                        />
                      </StatusIconWrapper>
                      <Button
                        type="text"
                        size="small"
                        danger
                        onClick={() => removeItem(note)}
                        icon={<DeleteIcon size={14} className="lucide-custom" />}
                      />
                    </FlexAlignCenter>
                  )
                }}
              />
            )}
          </DynamicVirtualList>
        )}
      </KnowledgeSourceContent>
    </KnowledgeSourceBody>
  )
}

const NotePreview = styled.span`
  cursor: pointer;
  color: var(--color-text-1);

  &:hover {
    color: var(--color-primary);
    text-decoration: underline;
  }
`

export default KnowledgeNotes
