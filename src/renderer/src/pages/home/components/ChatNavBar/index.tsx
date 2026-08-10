import { NavbarHeader } from '@renderer/components/app/Navbar'
import { useAssistant } from '@renderer/hooks/useAssistant'
import type { Assistant } from '@renderer/types'
import type { FC } from 'react'

import ChatNavbarContent from './ChatNavbarContent'

interface Props {
  activeAssistant: Assistant
}

// LOCK-002: navigation is fixed to the left layout; the top-navbar assistant
// toggle/drawer controls are removed.
const HeaderNavbar: FC<Props> = ({ activeAssistant }) => {
  const { assistant } = useAssistant(activeAssistant.id)

  return (
    <NavbarHeader className="home-navbar" style={{ height: 'var(--navbar-height)' }}>
      <div className="flex h-full min-w-0 flex-1 shrink items-center overflow-auto">
        <ChatNavbarContent assistant={assistant} />
      </div>
    </NavbarHeader>
  )
}

export default HeaderNavbar
