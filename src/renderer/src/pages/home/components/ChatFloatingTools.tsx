import NavbarIcon from '@renderer/components/NavbarIcon'
import SearchPopup from '@renderer/components/Popups/SearchPopup'
import { Tooltip } from 'antd'
import { Search } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

import Tools from './ChatNavBar/Tools'
import { TitlebarChipRight, TitlebarFloatRight } from './TitlebarFloat'

/**
 * Tool group floating in the overlay titlebar's right slot, on the
 * traffic-light row: global search plus the reused edit/settings tools. The
 * slot itself is transparent and click-through; the tools sit in one
 * hug-content 26px chip, opted out of window drag, clear of the native window
 * controls by the shared right clearance. The sidebar has its own single
 * Home-level toggle — no re-open entry lives here.
 */
const ChatFloatingTools: FC = () => {
  const { t } = useTranslation()

  return (
    <TitlebarFloatRight>
      <TitlebarChipRight>
        <Tooltip title={t('chat.assistant.search.placeholder')} mouseEnterDelay={0.8}>
          <NavbarIcon data-testid="chat-search-button" onClick={() => SearchPopup.show()}>
            <Search size={18} />
          </NavbarIcon>
        </Tooltip>
        <Tools />
      </TitlebarChipRight>
    </TitlebarFloatRight>
  )
}

export default ChatFloatingTools
