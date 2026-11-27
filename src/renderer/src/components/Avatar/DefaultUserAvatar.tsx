import { UserAvatar } from '@renderer/config/env'
import { User } from 'lucide-react'
import { memo } from 'react'
import styled, { css } from 'styled-components'

/**
 * Whether the stored avatar value is the default user identity rather than a
 * custom avatar. The bundled green image is the historical default: it ships
 * as the runtime initial value and as the reset target, so it persists as a
 * real avatar string and an empty-value fallback alone can never cover it.
 * Display sites treat it (and an unset value) as "no custom avatar" and
 * render the neutral fallback instead. Any other string — uploads, data URLs,
 * emoji — is a genuine user choice and keeps its own rendering path, so a
 * custom green picture is never mistaken for the default.
 */
export function isDefaultUserAvatar(avatar: string | null | undefined): boolean {
  return !avatar || avatar === UserAvatar
}

interface DefaultUserAvatarProps {
  size?: number
  iconSize?: number
  onClick?: () => void
  className?: string
  testId?: string
  title?: string
}

const avatarSurface = css<{ $size: number }>`
  display: flex;
  align-items: center;
  justify-content: center;
  width: ${(props) => props.$size}px;
  height: ${(props) => props.$size}px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background-color: var(--color-background-soft);
  color: var(--color-icon);
`

const StaticAvatar = styled.div<{ $size: number }>`
  ${avatarSurface}
`

const ClickableAvatar = styled.button<{ $size: number }>`
  ${avatarSurface}
  cursor: pointer;
  &:hover {
    opacity: 0.8;
  }
`

/**
 * Single reusable default user-avatar presentation: a neutral User outline on
 * a subtle surface. Scales with `size` (glyph defaults to ~55% of the box, so
 * 28px footer / 35px message / 80px profile stay proportional). Uses no
 * accent/emphasis color, so assistant/model avatars and the primary color are
 * untouched. Custom avatars never render here — callers gate on
 * {@link isDefaultUserAvatar} first.
 */
function DefaultUserAvatar({
  size = 28,
  iconSize,
  onClick,
  className,
  testId = 'default-user-avatar',
  title
}: DefaultUserAvatarProps) {
  const glyphSize = iconSize ?? Math.round(size * 0.55)
  const content = <User size={glyphSize} />
  if (onClick) {
    return (
      <ClickableAvatar
        $size={size}
        onClick={onClick}
        className={className}
        data-testid={testId}
        title={title}
        aria-label={title}>
        {content}
      </ClickableAvatar>
    )
  }
  return (
    <StaticAvatar $size={size} className={className} data-testid={testId} title={title}>
      {content}
    </StaticAvatar>
  )
}

export default memo(DefaultUserAvatar)
