import NavbarIcon from '@renderer/components/NavbarIcon'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { toggleEditMode } from '@renderer/store/editMode'
import { Tooltip } from 'antd'
import { Edit3 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { styled } from 'styled-components'

const EditModeToggle = () => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const isEnabled = useAppSelector((state) => state.editMode.enabled)

  const handleToggle = () => {
    dispatch(toggleEditMode(!isEnabled))
  }

  useShortcut(
    'toggle_edit_mode',
    () => {
      dispatch(toggleEditMode(!isEnabled))
    },
    { preventDefault: true }
  )

  return (
    <Tooltip title={isEnabled ? t('chat.edit.exit') : t('chat.edit.enter')} mouseEnterDelay={0.8}>
      <StyledNavbarIcon data-testid="edit-mode-toggle" onClick={handleToggle} $active={isEnabled}>
        <Edit3 size={18} />
      </StyledNavbarIcon>
    </Tooltip>
  )
}

const StyledNavbarIcon = styled(NavbarIcon)<{ $active: boolean }>`
  ${(p) =>
    p.$active &&
    `
    background-color: var(--color-primary);
    .lucide {
      color: var(--color-icon-white);
    }
    &:hover {
      background-color: var(--color-primary);
      opacity: 0.85;
    }
  `}
`

export default EditModeToggle
