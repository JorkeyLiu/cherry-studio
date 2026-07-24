import { useEditMode } from '@renderer/context/EditModeContext'
import { Button, Tooltip } from 'antd'
import { Clipboard, Copy, Redo2, Scissors, Trash2, Undo2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { styled } from 'styled-components'

const EditModeActionBar = () => {
  const { t } = useTranslation()
  const {
    selectedGroupIds,
    selectedGroups,
    hasClipboard,
    canUndo,
    canRedo,
    handleCopy,
    handleCut,
    handlePaste,
    handleDelete,
    handleUndo,
    handleRedo,
    handleClearSelection
  } = useEditMode()

  if (selectedGroupIds.length === 0) {
    return null
  }

  const totalSelectedMessages = selectedGroups.reduce((sum, g) => sum + g.messages.length, 0)

  return (
    <Container>
      <ActionBar>
        <SelectionCount>{t('chat.edit.selected', { count: totalSelectedMessages })}</SelectionCount>
        <ActionButtons>
          <Tooltip title={t('common.copy')}>
            <ActionButton
              shape="circle"
              color="default"
              variant="text"
              icon={<Copy size={16} />}
              onClick={handleCopy}
            />
          </Tooltip>
          <Tooltip title={t('chat.edit.cutAction')}>
            <ActionButton
              shape="circle"
              color="default"
              variant="text"
              icon={<Scissors size={16} />}
              onClick={handleCut}
            />
          </Tooltip>
          <Tooltip title={t('chat.edit.pasteAction')}>
            <ActionButton
              shape="circle"
              color="default"
              variant="text"
              icon={<Clipboard size={16} />}
              disabled={!hasClipboard}
              onClick={() => void handlePaste()}
            />
          </Tooltip>
          <Tooltip title={t('chat.edit.deleteAction')}>
            <ActionButton
              shape="circle"
              color="danger"
              variant="text"
              danger
              icon={<Trash2 size={16} />}
              onClick={() => void handleDelete()}
            />
          </Tooltip>
          <Tooltip title={t('chat.edit.undoAction')}>
            <ActionButton
              shape="circle"
              color="default"
              variant="text"
              icon={<Undo2 size={16} />}
              disabled={!canUndo}
              onClick={() => void handleUndo()}
            />
          </Tooltip>
          <Tooltip title={t('chat.edit.redoAction')}>
            <ActionButton
              shape="circle"
              color="default"
              variant="text"
              icon={<Redo2 size={16} />}
              disabled={!canRedo}
              onClick={() => void handleRedo()}
            />
          </Tooltip>
        </ActionButtons>
        <Tooltip title={t('chat.edit.deselect')}>
          <ActionButton
            shape="circle"
            color="default"
            variant="text"
            icon={<X size={16} />}
            onClick={handleClearSelection}
          />
        </Tooltip>
      </ActionBar>
    </Container>
  )
}

const Container = styled.div`
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 8px 16px;
  /*
   * The parent MessagesContainer is a column-reverse flex + scroll container, so this bar
   * renders at the visual top. Keeping it a direct child lets sticky travel the full scroll
   * range, while the negative margin collapses the height it would otherwise reserve in the
   * flow (which showed up as blank space above the Prompt). The bar overlays content instead.
   */
  margin-top: -100%;
`

const ActionBar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  background-color: var(--color-background);
  padding: 4px 4px;
  border-radius: 99px;
  box-shadow: 0px 2px 8px 0px rgb(128 128 128 / 20%);
  border: 0.5px solid var(--color-border);
  gap: 16px;
`

const ActionButtons = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`

const ActionButton = styled(Button)``

const SelectionCount = styled.div`
  color: var(--color-text-2);
  font-size: 14px;
  padding-left: 8px;
  flex-shrink: 0;
`

export default EditModeActionBar
