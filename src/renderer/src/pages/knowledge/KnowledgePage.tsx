import { DraggableList } from '@renderer/components/DraggableList'
import { DeleteIcon, EditIcon } from '@renderer/components/Icons'
import ListItem from '@renderer/components/ListItem'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import { useKnowledgeBases } from '@renderer/hooks/useKnowledge'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import type { KnowledgeBase } from '@renderer/types'
import type { MenuProps } from 'antd'
import { Button, Dropdown, Empty, Flex, Modal, Select } from 'antd'
import { ArrowUpDown, Book, Ellipsis, Plus, Settings } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import AddKnowledgeBasePopup from './components/AddKnowledgeBasePopup'
import EditKnowledgeBasePopup from './components/EditKnowledgeBasePopup'
import KnowledgeSearchPopup from './components/KnowledgeSearchPopup'
import KnowledgeContent from './KnowledgeContent'

const KnowledgePage: FC = () => {
  const { t } = useTranslation()
  const { bases, renameKnowledgeBase, deleteKnowledgeBase, updateKnowledgeBases } = useKnowledgeBases()
  const [selectedBase, setSelectedBase] = useState<KnowledgeBase | undefined>(bases[0])
  const [reorderOpen, setReorderOpen] = useState(false)

  const handleAddKnowledge = useCallback(async () => {
    const newBase = await AddKnowledgeBasePopup.show({ title: t('knowledge.add.title') })
    if (newBase) {
      setSelectedBase(newBase)
    }
  }, [t])

  const handleEditKnowledgeBase = useCallback(async (base: KnowledgeBase) => {
    const newBase = await EditKnowledgeBasePopup.show({ base })
    if (newBase && newBase?.id !== base.id) {
      setSelectedBase(newBase)
    }
  }, [])

  // Keep the selection valid: reselect the first base when the selected one
  // is deleted, and clear it when the last base is gone. Reordering never
  // touches the selection: updateKnowledgeBases only permutes store order.
  useEffect(() => {
    const hasSelectedBase = bases.find((base) => base.id === selectedBase?.id)
    if (!hasSelectedBase) {
      setSelectedBase(bases[0])
    }
  }, [bases, selectedBase])

  const getMenuItems = useCallback(
    (base: KnowledgeBase) => {
      const menus: MenuProps['items'] = [
        {
          label: t('knowledge.rename'),
          key: 'rename',
          icon: <EditIcon size={14} />,
          async onClick() {
            const name = await PromptPopup.show({
              title: t('knowledge.rename'),
              message: '',
              defaultValue: base.name || ''
            })
            if (name && base.name !== name) {
              renameKnowledgeBase(base.id, name)
            }
          }
        },
        {
          label: t('common.settings'),
          key: 'settings',
          icon: <Settings size={14} />,
          onClick: () => handleEditKnowledgeBase(base)
        },
        {
          // NEW locale key (reported, not shipped): knowledge.reorder.
          label: t('knowledge.reorder'),
          key: 'reorder',
          icon: <ArrowUpDown size={14} />,
          onClick: () => setReorderOpen(true)
        },
        { type: 'divider' },
        {
          label: t('common.delete'),
          danger: true,
          key: 'delete',
          icon: <DeleteIcon size={14} className="lucide-custom" />,
          onClick: () => {
            window.modal.confirm({
              title: t('knowledge.delete_confirm'),
              centered: true,
              onOk: () => {
                setSelectedBase(undefined)
                deleteKnowledgeBase(base.id)
              }
            })
          }
        }
      ]

      return menus
    },
    [deleteKnowledgeBase, handleEditKnowledgeBase, renameKnowledgeBase, t]
  )

  useShortcut('search_message', () => {
    if (selectedBase) {
      void KnowledgeSearchPopup.show({ base: selectedBase }).then()
    }
  })

  return (
    <Container data-testid="knowledge-page">
      <BaseBar>
        <BaseSelect
          data-testid="knowledge-base-select"
          value={selectedBase?.id}
          placeholder={t('knowledge.no_bases')}
          onChange={(value) => {
            const baseId = value as string
            const base = bases.find((b) => b.id === baseId)
            if (base) {
              setSelectedBase(base)
            }
          }}
          options={bases.map((base) => ({ value: base.id, label: base.name }))}
          prefix={<Book size={14} />}
          showSearch
          optionFilterProp="label"
        />
        <Flex align="center" gap={4} style={{ flexShrink: 0 }}>
          <Button
            type="text"
            size="small"
            data-testid="knowledge-base-add"
            icon={<Plus size={16} />}
            aria-label={t('button.add')}
            onClick={handleAddKnowledge}
          />
          {selectedBase && (
            <Dropdown menu={{ items: getMenuItems(selectedBase) }} trigger={['click']} placement="bottomRight">
              <Button
                type="text"
                size="small"
                data-testid="knowledge-base-more"
                icon={<Ellipsis size={16} />}
                aria-label={t('common.more')}
              />
            </Dropdown>
          )}
        </Flex>
      </BaseBar>
      <Body>
        {bases.length === 0 || !selectedBase ? (
          <EmptyWrap>
            <Empty description={t('knowledge.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
            <Button type="primary" size="small" icon={<Plus size={14} />} onClick={handleAddKnowledge}>
              {t('button.add')}
            </Button>
          </EmptyWrap>
        ) : (
          <KnowledgeContent key={selectedBase.id} selectedBase={selectedBase} />
        )}
      </Body>
      <Modal
        title={t('knowledge.reorder')}
        open={reorderOpen}
        onCancel={() => setReorderOpen(false)}
        footer={null}
        width={320}
        centered
        destroyOnHidden>
        <ReorderList>
          <DraggableList list={bases} onUpdate={updateKnowledgeBases}>
            {(base: KnowledgeBase) => (
              <ListItem
                active={selectedBase?.id === base.id}
                icon={<Book size={16} />}
                title={base.name}
                onClick={() => {
                  setSelectedBase(base)
                  setReorderOpen(false)
                }}
              />
            )}
          </DraggableList>
        </ReorderList>
      </Modal>
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

const BaseBar = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 0.5px solid var(--color-border);
  flex-shrink: 0;
`

const BaseSelect = styled(Select)`
  flex: 1;
  min-width: 0;
`

const Body = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
`

const EmptyWrap = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex: 1;
  min-height: 0;
  padding: 24px;
`

const ReorderList = styled.div`
  max-height: 320px;
  overflow-y: auto;
  padding: 4px 0;
`

export default KnowledgePage
