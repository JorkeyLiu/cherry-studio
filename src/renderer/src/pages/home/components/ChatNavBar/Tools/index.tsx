import EditModeToggle from '@renderer/components/EditModeToggle'
import { HStack } from '@renderer/components/Layout'
import { useAppSelector } from '@renderer/store'
import type { Assistant } from '@renderer/types'

import SettingsButton from './SettingsButton'

interface ToolsProps {
  assistant?: Assistant
}

// LOCK-002/008: the top-navbar branches (narrow-mode toggle, search, topic
// panel toggle) are removed with the fixed left-nav layout and narrowMode.
const Tools = ({ assistant }: ToolsProps) => {
  const activeTopicId = useAppSelector((state) => state.runtime.chat.activeTopic?.id)

  return (
    <HStack alignItems="center" gap={8}>
      {activeTopicId && <EditModeToggle />}
      <SettingsButton assistant={assistant} />
    </HStack>
  )
}

export default Tools
