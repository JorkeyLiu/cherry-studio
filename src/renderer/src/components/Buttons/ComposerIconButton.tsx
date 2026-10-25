import type { ButtonProps } from 'antd'
import type { FC, ReactNode } from 'react'
import styled, { css } from 'styled-components'

import ActionIconButton from './ActionIconButton'

export type ComposerIconTone = 'default' | 'primary'

interface ComposerIconButtonProps extends ButtonProps {
  children: ReactNode
  active?: boolean
  tone?: ComposerIconTone
}

/**
 * Shared composer tool button: ActionIconButton adapted to the main composer
 * geometry (28x28 hit target, 16px glyph) for every active composer control
 * (tool icons, settings, translation, send, collapse, stop-generation).
 *
 * Why this exists: the global `.lucide:not(.lucide-custom)` pin in
 * `assets/styles/index.css` forces every lucide glyph to `--color-icon`,
 * which silently defeated per-button inline `color` (send enabled/disabled
 * rendered identically) and per-button `:hover` icon recoloring. These
 * unlayered rules intentionally win over that layered pin and over the
 * layered Tailwind icon utilities, while the antd text-button hover
 * background (the existing standard hover) is left untouched.
 *
 * Global ActionIconButton defaults (30px) are unchanged: unrelated product
 * buttons keep their size. Disabled state never advertises the enabled
 * action (active affordance is suppressed while disabled, icon falls back
 * to `--color-text-3`).
 */
export const StyledComposerButton = styled(ActionIconButton)<{ $tone: ComposerIconTone }>`
  && {
    width: 28px;
    height: 28px;
    min-width: 28px;
    padding: 0;
  }

  /* Glyph lockdown: every composer tool icon renders at 16px regardless of
     the size prop passed to the underlying lucide component. */
  && .lucide {
    width: 16px;
    height: 16px;
  }

  ${(p) =>
    p.$tone === 'primary'
      ? css`
          && .lucide {
            color: var(--color-primary);
          }
        `
      : css`
          && .lucide {
            color: var(--color-icon);
          }`}

  /* Disabled must not advertise the enabled action: no hover background,
     icon pinned to --color-text-3 (covers lucide, antd and custom glyphs). */
  &&:disabled .lucide,
  &&.ant-btn-disabled .lucide,
  &&:disabled .anticon,
  &&.ant-btn-disabled .anticon,
  &&:disabled .icon,
  &&.ant-btn-disabled .icon {
    color: var(--color-text-3);
  }
  &&:disabled,
  &&.ant-btn-disabled {
    background: transparent;
    cursor: not-allowed;
  }
  &&:disabled:hover,
  &&.ant-btn-disabled:hover {
    background: transparent;
  }

  /* Visible keyboard focus: beats both the antd focus-visible reset and the
     global focus outline reset by specificity. */
  &&:not(:disabled):not(.ant-btn-disabled):focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 1px;
  }
`

const ComposerIconButton: FC<ComposerIconButtonProps> = ({
  tone = 'default',
  active,
  disabled,
  children,
  ...props
}) => {
  return (
    <StyledComposerButton $tone={tone} active={active && !disabled} disabled={disabled} data-tone={tone} {...props}>
      {children}
    </StyledComposerButton>
  )
}

export default ComposerIconButton
