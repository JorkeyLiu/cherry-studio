/**
 * Dynamic Island dual-mode behavior for InputbarCore:
 * - Expanded -> collapsed capsule on outside click / blur / Escape (respecting
 *   internal controls, open overlays, IME composition, and ContentSearch).
 * - Collapsed capsule -> expanded composer on Space / Enter / capsule click
 *   without hijacking other inputs, buttons, or editable elements.
 * - Draft text survives collapse/expand, and window focus never steals focus
 *   while collapsed.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  setExtensions: vi.fn(),
  setFiles: vi.fn(),
  setTimeoutTimer: vi.fn()
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key })
  }
})

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => mocks.dispatch
}))

vi.mock('@renderer/store/runtime', () => ({
  setSearching: vi.fn()
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({
    sendMessageShortcut: 'Enter',
    fontSize: 14,
    pasteLongTextAsFile: false,
    pasteLongTextThreshold: 1500,
    enableSpellCheck: false
  })
}))

vi.mock('@renderer/hooks/useRuntime', () => ({
  useRuntime: () => ({ searching: false })
}))

vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => ({ setTimeoutTimer: mocks.setTimeoutTimer })
}))

vi.mock('@renderer/pages/home/Inputbar/context/InputbarToolsProvider', () => ({
  useInputbarToolsState: () => ({ files: [] }),
  useInputbarToolsDispatch: () => ({ setFiles: mocks.setFiles }),
  useInputbarToolsInternalDispatch: () => ({ setExtensions: mocks.setExtensions })
}))

vi.mock('@renderer/pages/home/Inputbar/hooks/usePasteHandler', () => ({
  usePasteHandler: () => ({ handlePaste: vi.fn() })
}))

vi.mock('@renderer/pages/home/Inputbar/hooks/useFileDragDrop', () => ({
  useFileDragDrop: () => ({
    handleDragEnter: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDragOver: vi.fn(),
    handleDrop: vi.fn(),
    isDragging: false
  })
}))

vi.mock('@renderer/pages/home/Inputbar/registry', () => ({
  getInputbarConfig: () => ({ enableDragDrop: false })
}))

vi.mock('@renderer/components/TranslateButton', () => ({
  default: () => <div data-testid="translate-mock" />
}))

vi.mock('@renderer/pages/home/Inputbar/AttachmentPreview', () => ({
  default: () => null
}))

vi.mock('@renderer/pages/home/Inputbar/components/InputbarSettings', () => ({
  default: () => null
}))

vi.mock('@renderer/services/PasteService', () => ({
  default: {
    init: vi.fn(),
    registerHandler: vi.fn(),
    unregisterHandler: vi.fn(),
    setLastFocusedComponent: vi.fn(),
    getLastFocusedComponent: () => 'inputbar'
  }
}))

vi.mock('antd', async (importOriginal) => {
  const actual: any = await importOriginal<any>()
  return {
    ...actual,
    Tooltip: ({ children }: any) => <>{children}</>
  }
})

vi.mock('@ant-design/icons', () => ({
  HolderOutlined: () => <span data-testid="drag-handle-icon" />
}))

import { TopicType } from '@renderer/types'
import React, { useState } from 'react'

import { InputbarCore } from '../InputbarCore'

function StatefulIslandHarness({
  initialExpanded = true,
  initialText = 'draft text',
  focusSpy = vi.fn()
}: {
  initialExpanded?: boolean
  initialText?: string
  focusSpy?: ReturnType<typeof vi.fn>
}) {
  const [expanded, setExpanded] = useState(initialExpanded)
  const [text, setText] = useState(initialText)
  const textareaRef = React.useRef<any>(null)

  return (
    <div>
      <div data-testid="outside-canvas">messages area</div>
      <button type="button" data-testid="external-button">
        External Button
      </button>
      <input data-testid="external-input" defaultValue="" />
      <InputbarCore
        scope={TopicType.Chat}
        text={text}
        onTextChange={setText}
        textareaRef={textareaRef}
        resizeTextArea={vi.fn()}
        focusTextarea={focusSpy}
        height={undefined}
        onHeightChange={vi.fn()}
        supportedExts={[]}
        isLoading={false}
        onPause={vi.fn()}
        handleSendMessage={vi.fn()}
        leftToolbar={
          <button type="button" data-testid="internal-tool-btn">
            Tool
          </button>
        }
        expanded={expanded}
        onExpandedChange={setExpanded}
      />
    </div>
  )
}

beforeEach(() => {
  ;(window as any).electron = { ipcRenderer: { on: vi.fn(() => vi.fn()) } }
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    cb(0)
    return 1
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('InputbarCore Dynamic Island dual-mode behavior', () => {
  it('collapses when clicking outside the island and keeps draft text on re-expand', () => {
    const focusSpy = vi.fn()
    render(<StatefulIslandHarness initialExpanded={true} initialText="keep my draft" focusSpy={focusSpy} />)

    const island = document.getElementById('inputbar')!
    expect(island.classList.contains('is-collapsed')).toBe(false)

    // Clicking an internal toolbar button keeps the composer expanded.
    fireEvent.pointerDown(screen.getByTestId('internal-tool-btn'))
    fireEvent.pointerUp(screen.getByTestId('internal-tool-btn'))
    expect(island.classList.contains('is-collapsed')).toBe(false)

    // Clicking outside onto the message canvas collapses to capsule.
    fireEvent.pointerDown(screen.getByTestId('outside-canvas'))
    expect(island.classList.contains('is-collapsed')).toBe(true)

    // Clicking the capsule expands again and preserves draft text.
    fireEvent.click(screen.getByTestId('inputbar-capsule'))
    expect(island.classList.contains('is-collapsed')).toBe(false)
    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect((document.querySelector('#inputbar textarea') as HTMLTextAreaElement).value).toBe('keep my draft')
  })

  it('collapses on Escape when clear, but respects IME composition and open overlays', () => {
    render(<StatefulIslandHarness initialExpanded={true} />)
    const island = document.getElementById('inputbar')!

    // IME composing Escape does not collapse.
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })
      )
    })
    expect(island.classList.contains('is-collapsed')).toBe(false)

    // Active ContentSearch blocks Escape collapse.
    const searchHost = document.createElement('div')
    searchHost.setAttribute('data-testid', 'content-search-host')
    document.body.appendChild(searchHost)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(island.classList.contains('is-collapsed')).toBe(false)
    searchHost.remove()

    // Plain Escape collapses.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(island.classList.contains('is-collapsed')).toBe(true)
  })

  it('expands on Space or Enter when collapsed, without hijacking external inputs or buttons', () => {
    const focusSpy = vi.fn()
    render(<StatefulIslandHarness initialExpanded={false} focusSpy={focusSpy} />)
    const island = document.getElementById('inputbar')!
    expect(island.classList.contains('is-collapsed')).toBe(true)

    // External input holds focus -> Space does NOT expand.
    const extInput = screen.getByTestId('external-input')
    extInput.focus()
    act(() => {
      extInput.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }))
    })
    expect(island.classList.contains('is-collapsed')).toBe(true)

    // External button holds focus -> Enter does NOT expand.
    const extBtn = screen.getByTestId('external-button')
    extBtn.focus()
    act(() => {
      extBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(island.classList.contains('is-collapsed')).toBe(true)

    // Focus returns to body -> Space expands and prevents default scroll.
    extBtn.blur()
    const spaceEvent = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true })
    act(() => {
      window.dispatchEvent(spaceEvent)
    })
    expect(spaceEvent.defaultPrevented).toBe(true)
    expect(island.classList.contains('is-collapsed')).toBe(false)
    expect(focusSpy).toHaveBeenCalledTimes(1)

    // Collapse again, then Enter expands.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(island.classList.contains('is-collapsed')).toBe(true)

    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => {
      window.dispatchEvent(enterEvent)
    })
    expect(enterEvent.defaultPrevented).toBe(true)
    expect(island.classList.contains('is-collapsed')).toBe(false)
  })

  it('does not steal focus on window OS focus while collapsed', () => {
    const focusSpy = vi.fn()
    render(<StatefulIslandHarness initialExpanded={false} focusSpy={focusSpy} />)

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(focusSpy).not.toHaveBeenCalled()
  })
})
