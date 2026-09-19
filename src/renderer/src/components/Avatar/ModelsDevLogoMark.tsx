import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import styled from 'styled-components'

interface ModelsDevLogoMarkProps {
  /** Sanitized `models.dev` logo data URL (safe cache output). Transparent origin, never a custom upload. */
  src: string
  /** Outer avatar diameter in px. */
  size: number
  /** Fallback rendered when the logo probe fails (deterministic initial per caller). */
  fallback: ReactNode
  className?: string
  style?: CSSProperties
  /** Accessible label for the monochrome mark. */
  label: string
}

/**
 * Reusable monochrome `models.dev` logo mark (single mask implementation).
 *
 * Rendering: remote SVG data URL is applied as a CSS mask over a high-contrast
 * theme token (`var(--color-text-1)` — dark in light theme, light in dark
 * theme) on a transparent circle. No `filter: invert`, no white backing, and
 * custom user uploads never flow through here (they stay full-color `<img>`).
 *
 * Failure: a hidden `<img>` probe using the same data URL flips to `fallback`
 * when the payload cannot decode. Pure CSS mask failure without an image
 * decode failure keeps the mask layer (accepted per spec); the existing
 * error-fallback contract (logo failure closes to the deterministic initial)
 * is preserved via the probe.
 */
export const ModelsDevLogoMark: React.FC<ModelsDevLogoMarkProps> = ({
  src,
  size,
  fallback,
  className,
  style,
  label
}) => {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [src])

  if (!src || failed) {
    return fallback
  }

  const markSize = Math.max(12, Math.round(size * 0.68))
  const maskUrl = `url("${src}")`

  return (
    <MaskAvatarCircle
      $size={size}
      className={className}
      style={style}
      role="img"
      aria-label={label}
      data-testid="models-dev-logo-avatar">
      <MaskShape
        $markSize={markSize}
        aria-hidden="true"
        data-testid="models-dev-logo-mark"
        style={{
          backgroundColor: 'var(--color-text-1)',
          maskImage: maskUrl,
          WebkitMaskImage: maskUrl
        }}
      />
      {/* Hidden decode probe: SVG data-URL failures close to the caller fallback. */}
      <img
        src={src}
        alt=""
        aria-hidden="true"
        data-testid="models-dev-logo-probe"
        style={{ display: 'none' }}
        onError={() => setFailed(true)}
      />
    </MaskAvatarCircle>
  )
}

const MaskAvatarCircle = styled.div<{ $size: number }>`
  width: ${(props) => props.$size}px;
  height: ${(props) => props.$size}px;
  min-width: ${(props) => props.$size}px;
  min-height: ${(props) => props.$size}px;
  border-radius: 50%;
  background: transparent;
  border: 0.5px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  flex-shrink: 0;
`

const MaskShape = styled.div<{ $markSize: number }>`
  width: ${(props) => props.$markSize}px;
  height: ${(props) => props.$markSize}px;
  flex-shrink: 0;
  background-color: var(--color-text-1);
  -webkit-mask-size: contain;
  mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
`

export default ModelsDevLogoMark
