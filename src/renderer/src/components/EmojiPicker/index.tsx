import type { FC } from 'react'
import React, { Suspense } from 'react'

const EmojiPickerInner = React.lazy(() => import('./EmojiPickerInner'))

interface Props {
  onEmojiClick: (emoji: string) => void
}

const EmojiPicker: FC<Props> = (props) => (
  <Suspense fallback={null}>
    <EmojiPickerInner {...props} />
  </Suspense>
)

export default EmojiPicker
