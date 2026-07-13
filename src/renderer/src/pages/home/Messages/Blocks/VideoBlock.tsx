import type { VideoMessageBlock } from '@renderer/types/newMessage'
import React, { Suspense } from 'react'

const MessageVideo = React.lazy(() => import('../MessageVideo'))

interface Props {
  block: VideoMessageBlock
}

const VideoBlock: React.FC<Props> = ({ block }) => {
  return (
    <Suspense fallback={null}>
      <MessageVideo block={block} />
    </Suspense>
  )
}

export default React.memo(VideoBlock)
