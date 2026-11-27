import { isMac } from '@renderer/config/constant'
import { useFullscreen } from '@renderer/hooks/useFullscreen'
import { useWorkspaceSidebar } from '@renderer/hooks/useStore'
import type { Assistant, Topic } from '@renderer/types'
import type { FC } from 'react'

import TopicContent from './ChatNavBar/ChatNavbarContent/TopicContent'
import { TitlebarFloatLeft } from './TitlebarFloat'

interface Props {
  assistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
}

/**
 * Branch selector floating in the overlay titlebar's left slot, on the
 * traffic-light row: the same branch-only pill (entry + breadcrumb),
 * opted out of window drag. Renders nothing for never-branched topics,
 * leaving a zero-size slot that blocks no message interaction.
 *
 * While the sidebar hides, the chat spans the full window, so the slot
 * shifts right past the native traffic lights plus the Home-level sidebar
 * toggle resting after them (12px where no traffic lights own the corner).
 * While the sidebar shows, the chat starts past the panel and the default
 * 12px slot inset applies.
 */
const ChatBranchFloat: FC<Props> = ({ assistant, activeTopic, setActiveTopic }) => {
  const { visible } = useWorkspaceSidebar()
  const isFullscreen = useFullscreen()
  const hiddenLeft = isMac && !isFullscreen ? 'var(--sidebar-toggle-hidden-left, 86px)' : '12px'
  const safeLeft = visible ? undefined : `calc(${hiddenLeft} + 30px + 8px)`

  return (
    <TitlebarFloatLeft style={safeLeft ? { left: safeLeft } : undefined}>
      <TopicContent assistant={assistant} activeTopic={activeTopic} setActiveTopic={setActiveTopic} />
    </TitlebarFloatLeft>
  )
}

export default ChatBranchFloat
