import type { Model } from '@renderer/types'
import { shouldShowModelId } from '@renderer/utils/modelDisplayName'
import { memo } from 'react'

export interface ModelNameWithIdProps {
  model: Pick<Model, 'name' | 'id'>
  className?: string
  style?: React.CSSProperties
  nameClassName?: string
  nameStyle?: React.CSSProperties
  idClassName?: string
  idStyle?: React.CSSProperties
  /** Inline maxWidth for the id span (e.g. '50%' or 220). Overrides idStyle maxWidth when set. */
  idMaxWidth?: string | number
  compact?: boolean
}

/**
 * Presentational primitive: renders Model.name as primary text and,
 * iff trimmed case-sensitive name !== trimmed id, renders Model.id after it
 * as muted monospace text with title. Same means show once.
 * Lightweight: no metadata lookup, search, selection, tags, provider semantics, or persistence.
 */
const ModelNameWithId = memo(
  ({
    model,
    className,
    style,
    nameClassName,
    nameStyle,
    idClassName,
    idStyle,
    idMaxWidth,
    compact = false
  }: ModelNameWithIdProps) => {
    const showId = shouldShowModelId(model.name, model.id)
    const containerClass =
      className ?? (compact ? 'inline-flex min-w-0 items-center gap-1' : 'inline-flex min-w-0 items-center gap-1.5')
    const mergedIdStyle: React.CSSProperties | undefined =
      idMaxWidth !== undefined ? { ...idStyle, maxWidth: idMaxWidth as any } : idStyle

    return (
      <span className={containerClass} style={style} data-testid="model-name-with-id">
        <span className={nameClassName ?? 'min-w-0 truncate'} style={nameStyle}>
          {model.name}
        </span>
        {showId && (
          <span
            className={idClassName ?? 'min-w-0 shrink truncate font-mono text-[12px] text-[var(--color-text-3)]'}
            style={mergedIdStyle}
            title={model.id}>
            {model.id}
          </span>
        )}
      </span>
    )
  }
)

ModelNameWithId.displayName = 'ModelNameWithId'

export default ModelNameWithId
