import { Popover, Tooltip } from 'antd'
import { t } from 'i18next'
import { Settings2 } from 'lucide-react'
import type { FC } from 'react'
import { useState } from 'react'

import NavbarIcon from '../../../../../components/NavbarIcon'
import MessageSettings from './MessageSettings'

/**
 * LOCK-101: the independent quick-settings Drawer / AssistantSettingsTab
 * surface is removed. The navbar Settings2 button now opens a compact
 * arrowless message-settings Popover (~272px wide) near the message area.
 */
const SettingsButton: FC = () => {
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <Popover
      placement="bottom"
      trigger="click"
      arrow={false}
      open={settingsOpen}
      onOpenChange={setSettingsOpen}
      content={<MessageSettings />}
      styles={{
        root: { width: 272 }
      }}>
      <Tooltip title={t('settings.title')} mouseEnterDelay={0.8}>
        <NavbarIcon onClick={() => setSettingsOpen(true)}>
          <Settings2 size={18} />
        </NavbarIcon>
      </Tooltip>
    </Popover>
  )
}

export default SettingsButton
