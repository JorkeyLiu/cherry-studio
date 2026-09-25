import type { Assistant, Topic } from '@renderer/types'
import type { FC } from 'react'

import TopicContent from './TopicContent'

interface Props {
  assistant: Assistant
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
}

const ChatNavbarContent: FC<Props> = ({ assistant, activeTopic, setActiveTopic }) => {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-between">
      <TopicContent assistant={assistant} activeTopic={activeTopic} setActiveTopic={setActiveTopic} />
    </div>
  )
}

export default ChatNavbarContent
