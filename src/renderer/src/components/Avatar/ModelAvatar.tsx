import { useModelProviderLogo } from '@renderer/services/providerLogo'
import type { Model, Provider } from '@renderer/types'
import type { AvatarProps } from 'antd'
import { Avatar } from 'antd'
import { first } from 'lodash'
import type { FC } from 'react'

import { ModelsDevLogoMark } from './ModelsDevLogoMark'

interface Props {
  model?: Model
  /** Explicit owning provider (exact id match still enforced by the hook). */
  provider?: Provider | null
  /** Test seam: explicit models.dev logo override (null = no logo). */
  modelsDevLogoSrc?: string | null
  size: number
  props?: AvatarProps
  className?: string
}

const ModelAvatar: FC<Props> = ({ model, provider, modelsDevLogoSrc, size, props, className }) => {
  // Model avatar priority: owning provider's exact cached models.dev logo >
  // deterministic model initial. No model-specific logos are invented.
  // The models.dev logo shares ModelsDevLogoMark with ProviderAvatar (single
  // mask implementation): monochrome theme token on transparency.
  const hookLogo = useModelProviderLogo(model, provider !== undefined ? provider : undefined)
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
