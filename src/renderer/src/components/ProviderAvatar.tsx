import { useProviderModelsDevLogo } from '@renderer/services/providerLogo'
import type { Provider } from '@renderer/types'
import { generateColorFromChar, getFirstCharacter, getForegroundColor } from '@renderer/utils'
import { Avatar } from 'antd'
import React from 'react'
import styled from 'styled-components'

import { ModelsDevLogoMark } from './Avatar/ModelsDevLogoMark'

/** Logo origin: custom uploads stay full-color `<img>`; models.dev renders as a theme mask. */
export type ProviderLogoKind = 'custom' | 'models-dev'

interface ProviderAvatarPrimitiveProps {
  providerId: string
  providerName: string
  logoSrc?: string
  /** Defaults to `custom` to preserve the full-color `<img>` path for existing callers. */
  logoKind?: ProviderLogoKind
  size?: number
  className?: string
  style?: React.CSSProperties
}

interface ProviderAvatarProps {
  provider: Provider
  customLogos?: Record<string, string>
  /** Test seam: explicit models.dev logo override (null = no logo). */
  modelsDevLogoSrc?: string | null
  size?: number
  className?: string
  style?: React.CSSProperties
}

const ProviderLogo = styled(Avatar)`
  width: 100%;
  height: 100%;
  border: 0.5px solid var(--color-border);
`

export const ProviderAvatarPrimitive: React.FC<ProviderAvatarPrimitiveProps> = ({
  providerName,
  logoSrc,
  logoKind = 'custom',
  size,
  className,
  style
}) => {
  const displayName = providerName?.trim() ? providerName : ''
  const backgroundColor = generateColorFromChar(displayName || 'P')
  const color = displayName ? getForegroundColor(backgroundColor) : 'white'
  const fallback = (
    <ProviderLogo
      size={size}
      shape="circle"
      className={className}
      style={{
        backgroundColor,
        color,
        ...style
      }}>
      {getFirstCharacter(displayName) || 'P'}
    </ProviderLogo>
  )

  if (logoSrc) {
    // models.dev remote logos (safe-cache data URLs) render as a monochrome
    // theme mask on transparency; custom uploads keep their original colors.
    if (logoKind === 'models-dev') {
      return (
        <ModelsDevLogoMark
          src={logoSrc}
          size={size ?? 32}
          fallback={fallback}
          className={className}
          style={style}
          label={displayName || 'provider logo'}
        />
      )
    }
    return (
      <ProviderLogo draggable="false" shape="circle" src={logoSrc} className={className} style={style} size={size} />
    )
  }

  return fallback
}

export const ProviderAvatar: React.FC<ProviderAvatarProps> = ({
  provider,
  customLogos = {},
  modelsDevLogoSrc,
  className,
  style,
  size
}) => {
  // Avatar priority: user-uploaded custom image (`provider-${id}` key) >
  // exact cached models.dev logo (exact source attribution only) >
  // deterministic generic avatar. No brand catalog is consulted here.
  const customLogo = customLogos[provider.id]
  const hookLogo = useProviderModelsDevLogo(customLogo ? null : provider)
  const modelsDevLogo = modelsDevLogoSrc !== undefined ? modelsDevLogoSrc : hookLogo
  const logoSrc = customLogo ?? modelsDevLogo ?? undefined
  const logoKind: ProviderLogoKind = customLogo ? 'custom' : 'models-dev'

  if (logoSrc) {
    return (
      <ProviderAvatarPrimitive
        providerId={provider.id}
        providerName={provider.name}
        logoSrc={logoSrc}
        logoKind={logoKind}
        size={size}
        className={className}
        style={style}
      />
    )
  }

  return (
    <ProviderAvatarPrimitive
      providerId={provider.id}
      providerName={provider.name}
      size={size}
      className={className}
      style={style}
    />
  )
}
