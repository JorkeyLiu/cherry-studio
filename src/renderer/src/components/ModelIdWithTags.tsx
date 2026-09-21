import type { Model, Provider } from '@renderer/types'
import { memo } from 'react'

import ModelNameWithId from './ModelNameWithId'
import ModelTagsWithLabel from './ModelTagsWithLabel'

interface ModelIdWithTagsProps {
  model: Model
  /** Exact owning provider when the caller already has it; otherwise strict resolution applies. */
  provider?: Provider | null
  fontSize?: number
  showIdentifier?: boolean
  style?: React.CSSProperties
}

const ModelIdWithTags = ({
  ref,
  model,
  provider,
  fontSize = 14,
  showIdentifier = false,
  style
}: ModelIdWithTagsProps & { ref?: React.RefObject<HTMLDivElement> | null }) => {
  return (
    <div
      ref={ref}
      className="flex min-w-0 items-center gap-2.5 font-semibold text-(--color-text) leading-[1.2]"
      style={{ fontSize, ...style }}>
      {showIdentifier ? (
        <ModelNameWithId
          model={model}
          className="flex min-w-0 flex-1 items-center gap-2"
          nameClassName="block min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap leading-[1.3]"
          idClassName="min-w-0 max-w-[50%] shrink truncate font-mono text-(--color-text-3) text-[12px]! leading-[1.2]"
        />
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="block min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap leading-[1.3]">
            {model.name}
          </span>
        </div>
      )}
      <ModelTagsWithLabel model={model} provider={provider} size={11} style={{ flexShrink: 0 }} />
    </div>
  )
}

export default memo(ModelIdWithTags)
