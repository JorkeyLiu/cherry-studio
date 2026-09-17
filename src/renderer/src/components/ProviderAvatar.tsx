import type { Provider } from '@renderer/types'
import { generateColorFromChar, getFirstCharacter, getForegroundColor } from '@renderer/utils'
import { Avatar } from 'antd'
import React from 'react'
import styled from 'styled-components'

interface ProviderAvatarPrimitiveProps {
  providerId: string
  providerName: string
  logoSrc?: string
  size?: number
  className?: string
  style?: React.CSSProperties
}

interface ProviderAvatarProps {
  provider: Provider
  customLogos?: Record<string, string>
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
  size,
  className,
  style
}) => {
  if (logoSrc) {
    return (
      <ProviderLogo draggable="false" shape="circle" src={logoSrc} className={className} style={style} size={size} />
    )
  }

  const displayName = providerName?.trim() ? providerName : ''
  const backgroundColor = generateColorFromChar(displayName || 'P')
  const color = displayName ? getForegroundColor(backgroundColor) : 'white'

  return (
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
}

export const ProviderAvatar: React.FC<ProviderAvatarProps> = ({
  provider,
  customLogos = {},
  className,
  style,
  size
}) => {
  // Custom-connection avatar priority: user-uploaded custom image
  // (`provider-${id}` key) -> deterministic generic avatar. No built-in
  // brand logo catalog is consulted here.
  const customLogo = customLogos[provider.id]

  if (customLogo) {
    return (
      <ProviderAvatarPrimitive
        providerId={provider.id}
        providerName={provider.name}
        logoSrc={customLogo}
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
