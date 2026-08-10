import EmojiIcon from '@renderer/components/EmojiIcon'
import type { Assistant } from '@renderer/types'
import { getLeadingEmoji } from '@renderer/utils'
import type { FC } from 'react'
import { useMemo } from 'react'

interface AssistantAvatarProps {
  assistant: Assistant
  size?: number
  className?: string
}

// LOCK-002: assistant list avatars always use Emoji.
const AssistantAvatar: FC<AssistantAvatarProps> = ({ assistant, size = 24, className }) => {
  const assistantName = useMemo(() => assistant.name || '', [assistant.name])

  return <EmojiIcon emoji={assistant.emoji || getLeadingEmoji(assistantName)} size={size} className={className} />
}

export default AssistantAvatar
