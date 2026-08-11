import EditModeToggle from '@renderer/components/EditModeToggle'
import { HStack } from '@renderer/components/Layout'
import { useAppSelector } from '@renderer/store'

import SettingsButton from './SettingsButton'

// LOCK-002/008: the top-navbar branches (narrow-mode toggle, search, topic
// panel toggle) are removed with the fixed left-nav layout and narrowMode.
const Tools = () => {
  const activeTopicId = useAppSelector((state) => state.runtime.chat.activeTopic?.id)

  return (
    <HStack alignItems="center" gap={8}>
      {activeTopicId && <EditModeToggle />}
      <SettingsButton />
    </HStack>
  )
}

export default Tools
