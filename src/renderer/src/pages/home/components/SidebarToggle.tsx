import NavbarIcon from '@renderer/components/NavbarIcon'
import { isMac } from '@renderer/config/constant'
import { Tooltip } from 'antd'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import type { FC } from 'react'
import styled from 'styled-components'

interface SidebarToggleProps {
  visible: boolean
  isFullscreen: boolean
  title: string
  onToggle: () => void
}

/**
 * The single sidebar toggle: one control sliding with the panel. Expanded it
 * sits at the sidebar titlebar's right edge (the former collapse slot);
 * hidden it rests right of the native traffic lights. Position derives from
 * the live sidebar width var so it tracks drags, with the same 0.3s ease as
 * the panel — never a second show/hide button, never a narrow rail.
 *
 * Hit-test contract: the slot itself is click-through with no drag face so
 * the sidebar and chat drag bands stay continuous; the button below is the
 * ONLY pointer-events:auto + no-drag target in this slot (never a blanket
 * child recovery through the Tooltip layer), so its native no-drag hole
 * stays effective over whichever drag band sits beneath it.
 */
const SidebarToggle: FC<SidebarToggleProps> = ({ visible, isFullscreen, title, onToggle }) => {
  return (
    <SidebarToggleSlot $visible={visible} $isFullscreen={isFullscreen}>
      <Tooltip title={title} mouseEnterDelay={0.8}>
        <SidebarToggleButton data-testid="sidebar-collapse-button" onClick={onToggle}>
          {visible ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        </SidebarToggleButton>
      </Tooltip>
    </SidebarToggleSlot>
  )
}

// The single sidebar toggle: an absolute slot at Home level (a sibling of
// the panel, never inside its overflow-hidden motion wrapper so the slide
// is never clipped). Expanded it hugs the sidebar titlebar's right edge via
// the live sidebar width var; hidden it rests right of the native traffic
// lights (12px where no traffic lights own the corner). The slot itself is
// click-through with no drag face so the sidebar and chat drag bands stay
// continuous — only the button below opts out (no-drag) and receives hits.
// Left eases with the panel's own 0.3s timing.
const SidebarToggleSlot = styled.div<{ $visible: boolean; $isFullscreen: boolean }>`
  position: absolute;
  top: 0;
  left: ${({ $visible, $isFullscreen }) =>
    $visible
      ? 'calc(var(--workspace-sidebar-width, 300px) - 38px)'
      : isMac && !$isFullscreen
        ? 'var(--sidebar-toggle-hidden-left)'
        : '12px'};
  z-index: 30;
  display: flex;
  align-items: center;
  height: ${({ $isFullscreen }) => (isMac && !$isFullscreen ? 'max(30px, env(titlebar-area-height, 30px))' : 'var(--navbar-height, 44px)')};
  pointer-events: none;
  transition: left 0.3s ease-in-out;
`

// The sole interactive target in the slot: carries its own hit-test and
// drag opt-out explicitly instead of inheriting them from a blanket slot
// child rule through the Tooltip layer, so the hidden-state button keeps
// its native no-drag hole over the chat titlebar drag band beneath it.
const SidebarToggleButton = styled(NavbarIcon)`
  pointer-events: auto;
  -webkit-app-region: no-drag;
`

export default SidebarToggle
