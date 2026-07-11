import NavbarIcon from '@renderer/components/NavbarIcon'
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

  return (
    <Tooltip title={isEnabled ? t('chat.edit.exit') : t('chat.edit.enter')} mouseEnterDelay={0.8}>
      <StyledNavbarIcon onClick={handleToggle} $active={isEnabled}>
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
  `}
`

export default EditModeToggle
