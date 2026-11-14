import type { PopconfirmProps } from 'antd'
import { Popconfirm } from 'antd'
import type { GlobalToken } from 'antd/es/theme'
import antdTheme from 'antd/es/theme'
import type { TooltipRef } from 'antd/es/tooltip'
import type { CSSProperties, Ref } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * In-place confirmation popover for destructive actions anchored to a control.
 *
 * This is the shared standard for compact confirmations in dense UI (message
 * It stays compact and anchored: no modal mask and no extra chrome.
 * actions, branch rows). It wraps `antd` Popconfirm instead of forking it:
 * callers keep the full Popconfirm surface (`onConfirm` promises, `disabled`,
 * `onOpenChange`, placement, focus/trigger behavior) and the confirm action is
 * never wrapped or re-dispatched here.
 *
 * Contract:
 * - Button labels always come from the app locale (`common.confirm` /
 *   `common.cancel`), so a popup never falls back to the library's built-in
 *   English labels. Callers may still pass explicit `okText` / `cancelText`.
 * - Width is content-driven between `CONFIRM_POPOVER_MIN_WIDTH_CSS` and
 *   `CONFIRM_POPOVER_MAX_WIDTH_CSS`, capped by the viewport so small windows
 *   fit. No fixed width is set. Long unbroken strings wrap instead of
 *   overflowing the popover.
 * - `arrow` defaults to `true`; `arrow={false}` and all placements are
 *   supported for menu-sourced confirmations.
 * - Destructive callers pass `okButtonProps={{ danger: true }}` (the same
 *   contract other app confirmations use). This component never adds danger on
 *   its own, so non-destructive confirmations stay neutral.
 * - Caller `styles` / `classNames` are merged; the shared sizing constraints
 *   cannot be removed by a caller override.
 */
export const CONFIRM_POPOVER_MIN_WIDTH_PX = 260
export const CONFIRM_POPOVER_MAX_WIDTH_PX = 320
/** Horizontal viewport reserve for the minimum-width clamp. */
export const CONFIRM_POPOVER_MIN_WIDTH_VIEWPORT_INSET_PX = 32
/** Horizontal viewport reserve for the maximum-width clamp. */
export const CONFIRM_POPOVER_MAX_WIDTH_VIEWPORT_INSET_PX = 24

export const CONFIRM_POPOVER_MIN_WIDTH_CSS = `min(${CONFIRM_POPOVER_MIN_WIDTH_PX}px, calc(100vw - ${CONFIRM_POPOVER_MIN_WIDTH_VIEWPORT_INSET_PX}px))`
export const CONFIRM_POPOVER_MAX_WIDTH_CSS = `min(${CONFIRM_POPOVER_MAX_WIDTH_PX}px, calc(100vw - ${CONFIRM_POPOVER_MAX_WIDTH_VIEWPORT_INSET_PX}px))`

export const CONFIRM_POPOVER_CLASS_NAME = 'confirm-popover'

/** Expected inner padding in px; the live value still comes from `paddingSM`. */
export const CONFIRM_POPOVER_INNER_PADDING_PX = 12

export interface ConfirmPopoverStyleParts {
  root: CSSProperties
  body: CSSProperties
  classNames: {
    root: string
  }
}

/**
 * Sizing/wrapping contract shared with sibling in-place confirmations that do
 * not render through this component (e.g. a rename confirmation popover).
 * `token` is the antd theme token so the inner padding/font follow the app
 * theme rather than a duplicated constant.
 */
export const getConfirmPopoverStyleParts = (
  token: Pick<GlobalToken, 'paddingSM' | 'fontSize' | 'lineHeight'>
): ConfirmPopoverStyleParts => ({
  root: {
    // Content keeps its natural width; only the bounds are standardized.
    minWidth: CONFIRM_POPOVER_MIN_WIDTH_CSS,
    maxWidth: CONFIRM_POPOVER_MAX_WIDTH_CSS
  },
  body: {
    // The popover's own surface padding; matches the antd `paddingSM` token.
    padding: token.paddingSM,
    fontSize: token.fontSize,
    lineHeight: token.lineHeight,
    fontWeight: 'normal',
    // `overflow-wrap` is inherited by the message/title nodes, so an
    // unbreakable long string contributes a one-character min-content width
    // and wraps inside the popover bounds instead of overflowing them.
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    boxSizing: 'border-box'
  },
  classNames: {
    root: CONFIRM_POPOVER_CLASS_NAME
  }
})

export type ConfirmPopoverProps = PopconfirmProps & { ref?: Ref<TooltipRef> }

export const ConfirmPopover = ({ ref, ...props }: ConfirmPopoverProps) => {
  const { t } = useTranslation()
  const { token } = antdTheme.useToken()
  const {
    okText = t('common.confirm'),
    cancelText = t('common.cancel'),
    arrow = true,
    classNames,
    styles,
    ...restProps
  } = props
  const shared = getConfirmPopoverStyleParts(token)

  return (
    <Popconfirm
      {...restProps}
      ref={ref}
      arrow={arrow}
      okText={okText}
      cancelText={cancelText}
      classNames={{
        ...classNames,
        root: [classNames?.root, shared.classNames.root].filter(Boolean).join(' ')
      }}
      styles={{
        ...styles,
        root: { ...styles?.root, ...shared.root },
        body: { ...styles?.body, ...shared.body }
      }}
    />
  )
}

ConfirmPopover.displayName = 'ConfirmPopover'

export default ConfirmPopover
