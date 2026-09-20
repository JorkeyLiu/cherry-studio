import { useCanonicalModelLogo, useModelProviderLogo } from '@renderer/services/providerLogo'
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

const ModelAvatar: FC<Props> = ({ model, provider, modelsDevLogoSrc, size, props, className }) => {
  // Model avatar honesty: canonical lab logo (from models.json, independent of
  // proxy) > owning provider's exact models.dev source logo (connection/
  // provider fallback only when canonical is unknown) > deterministic model
  // initial. The provider fallback MUST NOT be treated as a canonical lab
  // logo — it is explicitly a connection/provider attribution used only when
  // the canonical lab is unknown, and is clearly documented as such.
  // The models.dev logo shares ModelsDevLogoMark with ProviderAvatar (single
  // mask implementation): monochrome theme token on transparency.
  const canonicalLogo = useCanonicalModelLogo(model)
  // `useModelProviderLogo` respects the exact owning-provider contract (no
  // default fallback) and is used here only as a second-tier fallback when
  // canonical is absent; never as a substitute for canonical lab identity.
  const providerLogo = useModelProviderLogo(model, provider === undefined ? undefined : provider)
  const hookLogo = canonicalLogo ?? providerLogo
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
