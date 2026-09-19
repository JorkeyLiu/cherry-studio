import { useCanonicalModelLogo } from '@renderer/services/providerLogo'
import type { Model, Provider } from '@renderer/types'
import type { AvatarProps } from 'antd'
import { Avatar } from 'antd'
import { first } from 'lodash'
import type { FC } from 'react'

import { ModelsDevLogoMark } from './ModelsDevLogoMark'

interface Props {
  model?: Model
  /** Explicit owning provider (accepted for call-site compatibility; model logos never use it). */
  provider?: Provider | null
  /** Test seam: explicit models.dev logo override (null = no logo). */
  modelsDevLogoSrc?: string | null
  size: number
  props?: AvatarProps
  className?: string
}

const ModelAvatar: FC<Props> = ({ model, provider: _provider, modelsDevLogoSrc, size, props, className }) => {
  // Model avatar priority: canonical model's lab/brand logo (resolved from
  // models.json, independent of the serving proxy connection) >
  // deterministic model initial. Unknown/ambiguous canonical resolution
  // yields the generic fallback, never the proxy connection logo.
  // The models.dev logo shares ModelsDevLogoMark with ProviderAvatar (single
  // mask implementation): monochrome theme token on transparency.
  const hookLogo = useCanonicalModelLogo(model)
  const logoSrc = modelsDevLogoSrc !== undefined ? modelsDevLogoSrc : hookLogo
  const avatarStyle = {
    width: size,
    height: size,
    minWidth: size,
    minHeight: size,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  } as const
  const fallback = (
    <Avatar style={avatarStyle} {...props} className={className}>
      {first(model?.name)}
    </Avatar>
  )
  if (logoSrc) {
    return (
      <ModelsDevLogoMark
        src={logoSrc}
        size={size}
        fallback={fallback}
        className={className}
        style={props?.style}
        label={model?.name ?? 'model logo'}
      />
    )
  }
  return fallback
}

export default ModelAvatar
