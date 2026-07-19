import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// Mock useCreateEditMode to avoid Redux store dependency
vi.mock('@renderer/hooks/useEditMode', () => ({
  useCreateEditMode: vi.fn(() => ({
    isEnabled: false,
    selectedGroupIds: [],
    selectedGroups: [],
    groups: [],
    hasClipboard: false,
    canUndo: false,
    canRedo: false,
    toggleEditMode: vi.fn(),
    handleGroupClick: vi.fn(),
    handleCopy: vi.fn(),
    handleCut: vi.fn(),
    handlePaste: vi.fn(),
    handleDelete: vi.fn(),
    handleMoveFocus: vi.fn(),
    handleExtendSelection: vi.fn(),
    handleClearSelection: vi.fn(),
    handleUndo: vi.fn(),
    handleRedo: vi.fn(),
    clearSelection: vi.fn()
  }))
}))

const { EditModeProvider, useEditMode, useOptionalEditMode } = await import('../EditModeContext')

// ── Helper components ───────────────────────────────────────────────────────

function StrictConsumer() {
  const ctx = useEditMode()
  return <div data-testid="strict">{ctx.isEnabled ? 'enabled' : 'disabled'}</div>
}

function OptionalConsumer() {
  const ctx = useOptionalEditMode()
  return <div data-testid="optional">{ctx ? 'has-context' : 'no-context'}</div>
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('EditModeContext', () => {
  describe('useEditMode (strict)', () => {
    it('throws when rendered outside EditModeProvider', () => {
      // Suppress React error boundary console noise
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

      expect(() => render(<StrictConsumer />)).toThrow('useEditMode must be used within an EditModeProvider')

      spy.mockRestore()
    })

    it('returns context when rendered inside EditModeProvider', () => {
      const { getByTestId } = render(
        <EditModeProvider topicId="t1">
          <StrictConsumer />
        </EditModeProvider>
      )

      expect(getByTestId('strict').textContent).toBe('disabled')
    })
  })

  describe('useOptionalEditMode', () => {
    it('returns null when rendered outside EditModeProvider', () => {
      const { getByTestId } = render(<OptionalConsumer />)
      expect(getByTestId('optional').textContent).toBe('no-context')
    })

    it('returns context when rendered inside EditModeProvider', () => {
      const { getByTestId } = render(
        <EditModeProvider topicId="t1">
          <OptionalConsumer />
        </EditModeProvider>
      )

      expect(getByTestId('optional').textContent).toBe('has-context')
    })
  })
})
