import { useModelProviderLogo } from '@renderer/services/providerLogo'
import type { Model, Provider } from '@renderer/types'
import type { AvatarProps } from 'antd'
import { Avatar } from 'antd'
import { first } from 'lodash'
import type { FC } from 'react'

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
  const hookLogo = useModelProviderLogo(model, provider !== undefined ? provider : undefined)
  const logoSrc = modelsDevLogoSrc !== undefined ? modelsDevLogoSrc : hookLogo
  if (logoSrc) {
    return (
      <Avatar
        src={logoSrc}
        style={{
          width: size,
          height: size,
          minWidth: size,
          minHeight: size,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
        {...props}
        className={className}
      />
    )
  }
  return (
    <Avatar
      style={{
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
      {...props}
      className={className}>
      {first(model?.name)}
    </Avatar>
  )
}

export default ModelAvatar
