/**
 * Mutual-exclusivity regression for the composer send/stop action slot.
 *
 * The inputbar exposes ONE action at a single position: idle renders send,
 * generation renders stop. The two must never coexist. Click wiring and the
 * original send-disabled validation (empty content blocks send) are
 * preserved; stop invokes the original pause/cancel path.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  setExtensions: vi.fn(),
  setFiles: vi.fn(),
  setTimeoutTimer: vi.fn()
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
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

import { InputbarCore } from '../InputbarCore'

function renderCore(props: Partial<React.ComponentProps<typeof InputbarCore>> = {}) {
  const textareaRef = { current: null }
  return render(
    <InputbarCore
      scope={TopicType.Chat}
      text="hello"
      onTextChange={vi.fn()}
      textareaRef={textareaRef as any}
      resizeTextArea={vi.fn()}
      focusTextarea={vi.fn()}
      height={undefined}
      onHeightChange={vi.fn()}
      supportedExts={[]}
      isLoading={false}
      onPause={vi.fn()}
      handleSendMessage={vi.fn()}
      {...props}
    />
  )
}

beforeEach(() => {
  ;(window as any).electron = { ipcRenderer: { on: vi.fn(() => vi.fn()) } }
})

describe('InputbarCore send/stop mutual exclusivity', () => {
  it('idle renders send only and click sends', () => {
    const handleSendMessage = vi.fn()
    renderCore({ isLoading: false, text: 'hello', handleSendMessage })

    const send = screen.getByTestId('send-message-button')
    expect(send).not.toBeDisabled()
    expect(screen.queryByTestId('stop-generation-button')).toBeNull()

    fireEvent.click(send)
    expect(handleSendMessage).toHaveBeenCalledTimes(1)
  })

  it('generation renders stop only and click pauses', () => {
    const onPause = vi.fn()
    const handleSendMessage = vi.fn()
    renderCore({ isLoading: true, text: 'hello', onPause, handleSendMessage })

    const stop = screen.getByTestId('stop-generation-button')
    expect(screen.queryByTestId('send-message-button')).toBeNull()

    fireEvent.click(stop)
    expect(onPause).toHaveBeenCalledTimes(1)
    expect(handleSendMessage).not.toHaveBeenCalled()
  })

  it('idle with empty content keeps send disabled (original send validation)', () => {
    renderCore({ isLoading: false, text: '   ' })

    const send = screen.getByTestId('send-message-button')
    expect(send).toBeDisabled()
    expect(screen.queryByTestId('stop-generation-button')).toBeNull()
  })
})
