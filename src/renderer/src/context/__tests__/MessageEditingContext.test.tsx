import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MessageEditingProvider, useMessageEditing } from '../MessageEditingContext'

function Harness() {
  const { editingMessageId, startEditing, stopEditing } = useMessageEditing()
  return (
    <div>
      <span data-testid="editing">{editingMessageId ?? 'none'}</span>
      <button type="button" onClick={() => startEditing('m1')}>
        start
      </button>
      <button type="button" onClick={() => stopEditing()}>
        stop
      </button>
    </div>
  )
}

describe('MessageEditingProvider reset token (PERF-100 editor close semantics)', () => {
  it('closes the active inline editor when the reset token changes', () => {
    const { getByTestId, getByText, rerender } = render(
      <MessageEditingProvider resetToken={false}>
        <Harness />
      </MessageEditingProvider>
    )

    fireEvent.click(getByText('start'))
    expect(getByTestId('editing').textContent).toBe('m1')

    // Simulate an edit-mode toggle: the MessageGroup passes isEditMode.
    rerender(
      <MessageEditingProvider resetToken={true}>
        <Harness />
      </MessageEditingProvider>
    )

    expect(getByTestId('editing').textContent).toBe('none')
  })

  it('keeps the inline editor open when the reset token is unchanged', () => {
    const { getByTestId, getByText, rerender } = render(
      <MessageEditingProvider resetToken={false}>
        <Harness />
      </MessageEditingProvider>
    )

    fireEvent.click(getByText('start'))
    rerender(
      <MessageEditingProvider resetToken={false}>
        <Harness />
      </MessageEditingProvider>
    )

    expect(getByTestId('editing').textContent).toBe('m1')
  })

  it('preserves editing when no reset token is provided (history consumers)', () => {
    const { getByTestId, getByText, rerender } = render(
      <MessageEditingProvider>
        <Harness />
      </MessageEditingProvider>
    )

    fireEvent.click(getByText('start'))
    rerender(
      <MessageEditingProvider>
        <Harness />
      </MessageEditingProvider>
    )

    expect(getByTestId('editing').textContent).toBe('m1')
  })

  it('still supports explicit stopEditing after a reset', () => {
    const { getByTestId, getByText, rerender } = render(
      <MessageEditingProvider resetToken={false}>
        <Harness />
      </MessageEditingProvider>
    )

    fireEvent.click(getByText('start'))
    rerender(
      <MessageEditingProvider resetToken={true}>
        <Harness />
      </MessageEditingProvider>
    )
    expect(getByTestId('editing').textContent).toBe('none')

    fireEvent.click(getByText('start'))
    expect(getByTestId('editing').textContent).toBe('m1')
    fireEvent.click(getByText('stop'))
    expect(getByTestId('editing').textContent).toBe('none')
  })
})
