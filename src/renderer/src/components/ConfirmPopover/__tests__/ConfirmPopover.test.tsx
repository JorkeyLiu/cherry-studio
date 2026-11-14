import { cleanup, render } from '@testing-library/react'
import type { PopconfirmProps } from 'antd'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CONFIRM_POPOVER_CLASS_NAME,
  CONFIRM_POPOVER_INNER_PADDING_PX,
  CONFIRM_POPOVER_MAX_WIDTH_CSS,
  CONFIRM_POPOVER_MIN_WIDTH_CSS,
  ConfirmPopover,
  type ConfirmPopoverProps
} from '../index'

/**
 * The shared confirmation wrapper is about the contract it hands to antd:
 * localized labels, bounded content-driven sizing, preserved trigger semantics
 * and untouched caller props. The mock renders the trigger inline and records
 * that handed-over contract, so the tests assert behaviour rather than the
 * popup library's internals.
 */
const captured = vi.hoisted(() => ({
  props: [] as Array<PopconfirmProps & { children?: ReactNode }>
}))

vi.mock('react-i18next', () => {
  const labels: Record<string, string> = {
    'common.confirm': 'Confirm',
    'common.cancel': 'Cancel'
  }
  return {
    useTranslation: () => ({ t: (key: string) => labels[key] ?? key }),
    initReactI18next: { type: '3rdParty', init: vi.fn() }
  }
})

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    Popconfirm: (props: PopconfirmProps & { children?: ReactNode }) => {
      captured.props.push(props)
      return <>{props.children}</>
    }
  }
})

const lastProps = () => captured.props.at(-1) as PopconfirmProps

const renderPopover = (props: Partial<ConfirmPopoverProps> = {}) =>
  render(
    <ConfirmPopover title="Delete?" {...props}>
      <button type="button">Delete</button>
    </ConfirmPopover>
  )

describe('ConfirmPopover', () => {
  beforeEach(() => {
    captured.props.length = 0
  })

  afterEach(() => {
    cleanup()
  })

  it('applies the app locale labels whenever the caller does not supply them', () => {
    const onConfirm = vi.fn()

    renderPopover({ onConfirm })

    const props = lastProps()
    expect(props.okText).toBe('Confirm')
    expect(props.cancelText).toBe('Cancel')
    expect(props.arrow).toBe(true)
    props.onConfirm?.()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('keeps explicit caller labels and the caller handler identity', () => {
    const onConfirm = vi.fn(async () => undefined)

    renderPopover({ okText: 'Remove', cancelText: 'Keep', onConfirm })

    const props = lastProps()
    expect(props.okText).toBe('Remove')
    expect(props.cancelText).toBe('Keep')
    expect(props.onConfirm).toBe(onConfirm)
  })

  it('gives the popup a content-driven, viewport-bounded size instead of a fixed width', () => {
    renderPopover()

    const styles = lastProps().styles
    expect(styles?.root).toMatchObject({
      minWidth: CONFIRM_POPOVER_MIN_WIDTH_CSS,
      maxWidth: CONFIRM_POPOVER_MAX_WIDTH_CSS
    })
    expect(styles?.root).not.toHaveProperty('width')
    expect(styles?.body).toMatchObject({
      padding: CONFIRM_POPOVER_INNER_PADDING_PX,
      fontWeight: 'normal',
      overflowWrap: 'anywhere',
      wordBreak: 'break-word'
    })
    expect(lastProps().classNames?.root).toContain(CONFIRM_POPOVER_CLASS_NAME)
  })

  it('preserves caller arrow, placement, disabled, open-state and non-size styles', () => {
    const onOpenChange = vi.fn()

    renderPopover({
      arrow: false,
      placement: 'bottomLeft',
      disabled: true,
      onOpenChange,
      classNames: { root: 'caller-popover' },
      styles: {
        root: { color: 'red' },
        body: { padding: 99, backgroundColor: 'blue' }
      }
    })

    const props = lastProps()
    expect(props.arrow).toBe(false)
    expect(props.placement).toBe('bottomLeft')
    expect(props.disabled).toBe(true)
    expect(props.classNames?.root).toBe(`caller-popover ${CONFIRM_POPOVER_CLASS_NAME}`)
    // Caller styling survives, but the shared sizing and padding cannot be
    // replaced by a caller override.
    expect(props.styles?.root).toMatchObject({
      color: 'red',
      minWidth: CONFIRM_POPOVER_MIN_WIDTH_CSS,
      maxWidth: CONFIRM_POPOVER_MAX_WIDTH_CSS
    })
    expect(props.styles?.body).toMatchObject({
      backgroundColor: 'blue',
      padding: CONFIRM_POPOVER_INNER_PADDING_PX
    })
    props.onOpenChange?.(true)
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  it('keeps danger explicit and never adds it to a neutral confirmation', () => {
    renderPopover({ okButtonProps: { danger: true } })
    expect(lastProps().okButtonProps).toEqual({ danger: true })

    cleanup()
    captured.props.length = 0
    renderPopover()
    expect(lastProps().okButtonProps).toBeUndefined()
  })
})
