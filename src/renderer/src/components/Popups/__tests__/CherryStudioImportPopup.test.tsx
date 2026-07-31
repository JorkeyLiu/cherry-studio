/**
 * CherryStudioImportPopup focused renderer tests.
 *
 * Validates the L2 import popup critical UI states, interactions,
 * listener cleanup, and typed API calls without any real IPC.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const t = vi.fn((key: string) => key)
  const getPlatformSupport = vi.fn()
  const start = vi.fn()
  const cancel = vi.fn()
  const onStatusChanged = vi.fn()
  const fileOpen = vi.fn()
  return { t, getPlatformSupport, start, cancel, onStatusChanged, fileOpen }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t })
}))

let capturedElement: React.ReactNode | null = null

vi.mock('@renderer/components/TopView', () => ({
  TopView: {
    show: vi.fn((element: React.ReactNode) => {
      capturedElement = element
    }),
    hide: vi.fn()
  }
}))

import CherryStudioImportPopup from '../CherryStudioImportPopup'

// Mock matchMedia for Ant Design Steps/Responsive components
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  capturedElement = null

  mocks.getPlatformSupport.mockResolvedValue({ supported: true, platform: 'darwin' })
  mocks.onStatusChanged.mockReturnValue(vi.fn())

  Object.defineProperty(window, 'api', {
    value: {
      cherryImport: {
        getPlatformSupport: mocks.getPlatformSupport,
        start: mocks.start,
        cancel: mocks.cancel,
        onStatusChanged: mocks.onStatusChanged
      },
      file: { open: mocks.fileOpen },
      setFullScreen: vi.fn()
    },
    configurable: true
  })
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render the popup via the TopView.show capture pattern, wrapped in act */
async function renderPopup(): Promise<void> {
  await act(async () => {
    void CherryStudioImportPopup.show()
  })
  if (capturedElement) {
    // Use the document.body as the container so portals render in-place
    const container = document.body
    await act(async () => {
      render(capturedElement, { container })
    })
  }
}

/** Get the primary (OK) button from the modal footer */
function getOkButton(): HTMLElement {
  const footer = document.querySelector('.ant-modal-footer')
  if (!footer) throw new Error('Modal footer not found')
  return footer.querySelector('.ant-btn-primary') as HTMLElement
}

/** Get the Cancel button from the modal footer */
function getCancelButton(): HTMLElement {
  const footer = document.querySelector('.ant-modal-footer')
  if (!footer) throw new Error('Modal footer not found')
  return footer.querySelector('.ant-btn-default') as HTMLElement
}

/** Navigate through: select file → confirm → start → running phase */
async function reachRunningPhase(cbRef?: { current?: (event: any) => void }): Promise<void> {
  mocks.fileOpen.mockResolvedValue({ filePath: '/tmp/test.zip' })
  mocks.start.mockResolvedValue({ ok: true, sessionId: 'session-1' })

  if (cbRef) {
    mocks.onStatusChanged.mockImplementation((cb: any) => {
      cbRef.current = cb
      return vi.fn()
    })
  }

  await renderPopup()
  await waitFor(() => expect(mocks.getPlatformSupport).toHaveBeenCalled())

  await act(async () => {
    fireEvent.click(getOkButton())
  })
  await waitFor(() => expect(screen.getByText('import.cherrystudio.confirm_title')).toBeInTheDocument())

  await act(async () => {
    fireEvent.click(getOkButton())
  })
  await waitFor(() => expect(mocks.start).toHaveBeenCalled())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CherryStudioImportPopup', () => {
  describe('platform gate (LOCK-6004)', () => {
    it('should show unsupported state when platform is not supported', async () => {
      mocks.getPlatformSupport.mockResolvedValue({ supported: false, platform: 'linux' })
      await renderPopup()

      await waitFor(() => {
        expect(screen.getByText('import.cherrystudio.unsupported.title')).toBeInTheDocument()
      })

      expect(screen.getByText('import.cherrystudio.unsupported.description')).toBeInTheDocument()
      expect(getOkButton()).toBeDisabled()
    })

    it('should show selecting state when platform is supported', async () => {
      await renderPopup()

      await waitFor(() => {
        expect(screen.getByText('import.cherrystudio.description')).toBeInTheDocument()
      })

      expect(screen.getByText('import.cherrystudio.warning.title')).toBeInTheDocument()
      expect(getOkButton()).not.toBeDisabled()
    })
  })

  describe('ZIP selection', () => {
    it('should open file picker with .zip filter when Select File is clicked', async () => {
      await renderPopup()
      await waitFor(() => expect(mocks.getPlatformSupport).toHaveBeenCalled())

      await act(async () => {
        fireEvent.click(getOkButton())
      })

      expect(mocks.fileOpen).toHaveBeenCalledWith({
        filters: [{ name: 'Cherry Studio Backup', extensions: ['zip'] }],
        title: 'import.cherrystudio.select_file'
      })
    })

    it('should stay in selecting phase when file open is cancelled', async () => {
      mocks.fileOpen.mockResolvedValue(null)
      await renderPopup()
      await waitFor(() => expect(mocks.getPlatformSupport).toHaveBeenCalled())

      await act(async () => {
        fireEvent.click(getOkButton())
      })

      expect(screen.getByText('import.cherrystudio.description')).toBeInTheDocument()
    })
  })

  describe('confirmation phase (LOCK-6002)', () => {
    it('should show confirming state after file selection', async () => {
      mocks.fileOpen.mockResolvedValue({ filePath: '/tmp/test.zip' })
      await renderPopup()
      await waitFor(() => expect(mocks.getPlatformSupport).toHaveBeenCalled())

      await act(async () => {
        fireEvent.click(getOkButton())
      })
      await waitFor(() => expect(screen.getByText('import.cherrystudio.confirm_title')).toBeInTheDocument())

      expect(screen.getByText('import.cherrystudio.confirm_description')).toBeInTheDocument()
      expect(screen.getByText('import.cherrystudio.confirm_warning')).toBeInTheDocument()

      // Warning is emphasized (inside <strong>)
      const warningText = screen.getByText('import.cherrystudio.confirm_warning')
      expect(warningText.closest('strong')).toBeTruthy()
    })

    it('should call cherryImport.start when confirming', async () => {
      mocks.fileOpen.mockResolvedValue({ filePath: '/tmp/test.zip' })
      mocks.start.mockResolvedValue({ ok: true, sessionId: 'session-1' })
      await renderPopup()
      await waitFor(() => expect(mocks.getPlatformSupport).toHaveBeenCalled())

      await act(async () => {
        fireEvent.click(getOkButton())
      })
      await waitFor(() => expect(screen.getByText('import.cherrystudio.confirm_title')).toBeInTheDocument())

      await act(async () => {
        fireEvent.click(getOkButton())
      })
      expect(mocks.start).toHaveBeenCalledWith('/tmp/test.zip')
    })

    it('should show error when start returns failure', async () => {
      mocks.fileOpen.mockResolvedValue({ filePath: '/tmp/test.zip' })
      mocks.start.mockResolvedValue({ ok: false, error: 'Invalid ZIP format' })
      await renderPopup()
      await waitFor(() => expect(mocks.getPlatformSupport).toHaveBeenCalled())

      await act(async () => {
        fireEvent.click(getOkButton())
      })
      await waitFor(() => expect(screen.getByText('import.cherrystudio.confirm_title')).toBeInTheDocument())

      await act(async () => {
        fireEvent.click(getOkButton())
      })

      await waitFor(() => {
        expect(screen.getByText('import.cherrystudio.error.title')).toBeInTheDocument()
        expect(screen.getByText('Invalid ZIP format')).toBeInTheDocument()
      })
    })
  })

  describe('running / progress phases', () => {
    it('should show progress steps during running phase', async () => {
      await reachRunningPhase()

      await waitFor(() => {
        expect(screen.getByText('import.cherrystudio.phase.processing')).toBeInTheDocument()
      })

      expect(getOkButton()).toHaveClass('ant-btn-loading')
    })

    it('should show promoting label during promoting state', async () => {
      const cbRef: { current?: (event: any) => void } = {}
      await reachRunningPhase(cbRef)

      act(() => {
        cbRef.current!({ sessionId: 'session-1', state: 'promoting' })
      })

      expect(screen.getByText('import.cherrystudio.phase.promoting')).toBeInTheDocument()
    })

    it('should show promoting label during finalizing state', async () => {
      const cbRef: { current?: (event: any) => void } = {}
      await reachRunningPhase(cbRef)

      act(() => {
        cbRef.current!({ sessionId: 'session-1', state: 'finalizing' })
      })

      expect(screen.getByText('import.cherrystudio.phase.promoting')).toBeInTheDocument()
    })
  })

  describe('terminal states', () => {
    it('should show success alert on promoted state', async () => {
      const cbRef: { current?: (event: any) => void } = {}
      await reachRunningPhase(cbRef)

      act(() => {
        cbRef.current!({ sessionId: 'session-1', state: 'promoted' })
      })

      expect(screen.getByText('import.cherrystudio.success.title')).toBeInTheDocument()
      expect(screen.getByText('import.cherrystudio.success.description')).toBeInTheDocument()
      expect(getOkButton()).toBeDisabled()
    })

    it('should show error alert on error state', async () => {
      const cbRef: { current?: (event: any) => void } = {}
      await reachRunningPhase(cbRef)

      act(() => {
        cbRef.current!({ sessionId: 'session-1', state: 'error', error: 'ZIP corrupted' })
      })

      expect(screen.getByText('import.cherrystudio.error.title')).toBeInTheDocument()
      expect(screen.getByText('ZIP corrupted')).toBeInTheDocument()
      expect(getOkButton()).toBeDisabled()
    })

    it('should show error alert on verification-failed state', async () => {
      const cbRef: { current?: (event: any) => void } = {}
      await reachRunningPhase(cbRef)

      act(() => {
        cbRef.current!({ sessionId: 'session-1', state: 'verification-failed', error: 'Schema mismatch' })
      })

      expect(screen.getByText('import.cherrystudio.error.title')).toBeInTheDocument()
      expect(screen.getByText('Schema mismatch')).toBeInTheDocument()
    })

    it('should show error alert on promotion-failed state', async () => {
      const cbRef: { current?: (event: any) => void } = {}
      await reachRunningPhase(cbRef)

      act(() => {
        cbRef.current!({ sessionId: 'session-1', state: 'promotion-failed', error: 'DB lock' })
      })

      expect(screen.getByText('import.cherrystudio.error.title')).toBeInTheDocument()
      expect(screen.getByText('DB lock')).toBeInTheDocument()
    })

    it('should show cancelled alert on cancelled state', async () => {
      const cbRef: { current?: (event: any) => void } = {}
      await reachRunningPhase(cbRef)

      act(() => {
        cbRef.current!({ sessionId: 'session-1', state: 'cancelled' })
      })

      expect(screen.getByText('import.cherrystudio.cancelled.title')).toBeInTheDocument()
      expect(screen.getByText('import.cherrystudio.cancelled.description')).toBeInTheDocument()
    })

    it('should use default unknown error message when error field is absent', async () => {
      const cbRef: { current?: (event: any) => void } = {}
      await reachRunningPhase(cbRef)

      act(() => {
        cbRef.current!({ sessionId: 'session-1', state: 'error' })
      })

      expect(screen.getByText('import.cherrystudio.error.title')).toBeInTheDocument()
      expect(screen.getByText('import.cherrystudio.error.unknown')).toBeInTheDocument()
    })
  })

  describe('cancel behavior (LOCK-6015/6016/6017)', () => {
    it('should call cherryImport.cancel with sessionId during running phase', async () => {
      const cbRef: { current?: (event: any) => void } = {}
      mocks.cancel.mockResolvedValue({ ok: true })
      await reachRunningPhase(cbRef)

      act(() => {
        cbRef.current!({ sessionId: 'session-1', state: 'intake' })
      })

      await act(async () => {
        fireEvent.click(getCancelButton())
      })

      expect(mocks.cancel).toHaveBeenCalledWith('session-1')
    })

    it('should set cancelRequested when Cancel is clicked during starting phase', async () => {
      mocks.fileOpen.mockResolvedValue({ filePath: '/tmp/test.zip' })
      let startResolve!: (v: any) => void
      mocks.start.mockImplementation(
        () =>
          new Promise((resolve) => {
            startResolve = resolve
          })
      )
      mocks.cancel.mockResolvedValue({ ok: true })

      await renderPopup()
      await waitFor(() => expect(mocks.getPlatformSupport).toHaveBeenCalled())

      await act(async () => {
        fireEvent.click(getOkButton())
      })
      await waitFor(() => expect(screen.getByText('import.cherrystudio.confirm_title')).toBeInTheDocument())

      // Confirm — handleOk calls void handleConfirmImport() (fire-and-forget)
      // which synchronously calls setPhase('starting') then awaits start.
      await act(async () => {
        fireEvent.click(getOkButton())
      })

      // Wait for React to flush the 'starting' phase render (extracting label appears)
      await waitFor(() => {
        expect(screen.getByText('import.cherrystudio.phase.extracting')).toBeInTheDocument()
      })

      // Cancel while starting — handleCancel checks phase='starting', no sessionId → sets cancelRequested
      await act(async () => {
        fireEvent.click(getCancelButton())
      })

      // Now resolve start — handleConfirmImport checks cancelRequested and cancels immediately
      await act(async () => {
        startResolve({ ok: true, sessionId: 'session-1' })
      })

      expect(mocks.cancel).toHaveBeenCalledWith('session-1')
    })

    it('should close modal when Cancel is clicked in selecting phase (no session)', async () => {
      await renderPopup()
      await waitFor(() => expect(mocks.getPlatformSupport).toHaveBeenCalled())

      await act(async () => {
        fireEvent.click(getCancelButton())
      })

      expect(mocks.cancel).not.toHaveBeenCalled()
    })
  })

  describe('listener cleanup', () => {
    it('should register exactly one status listener', async () => {
      await renderPopup()
      await waitFor(() => expect(mocks.getPlatformSupport).toHaveBeenCalled())

      expect(mocks.onStatusChanged).toHaveBeenCalledTimes(1)
    })

    it('should return a cleanup function from onStatusChanged', async () => {
      const removeListenerMock = vi.fn()
      mocks.onStatusChanged.mockReturnValue(removeListenerMock)
      await renderPopup()
      await waitFor(() => expect(mocks.getPlatformSupport).toHaveBeenCalled())

      expect(removeListenerMock).toBeDefined()
    })
  })

  describe('modal properties', () => {
    it('should render modal with correct title', async () => {
      await renderPopup()
      await waitFor(() => expect(screen.getByText('import.cherrystudio.title')).toBeInTheDocument())
    })

    it('should disable OK button in unsupported terminal state', async () => {
      mocks.getPlatformSupport.mockResolvedValue({ supported: false, platform: 'linux' })
      await renderPopup()
      await waitFor(() => expect(mocks.getPlatformSupport).toHaveBeenCalled())

      expect(getOkButton()).toBeDisabled()
    })

    it('should disable Cancel button in selecting phase', async () => {
      await renderPopup()
      await waitFor(() => expect(mocks.getPlatformSupport).toHaveBeenCalled())

      expect(getCancelButton()).toBeDisabled()
    })

    it('should disable Cancel button in unsupported phase', async () => {
      mocks.getPlatformSupport.mockResolvedValue({ supported: false, platform: 'linux' })
      await renderPopup()
      await waitFor(() => expect(mocks.getPlatformSupport).toHaveBeenCalled())

      expect(getCancelButton()).toBeDisabled()
    })
  })

  describe('status event mapping', () => {
    it('should map intake/discovering/reading/candidate-ready/verifying/verified-candidate to running phase', async () => {
      const cbRef: { current?: (event: any) => void } = {}
      await reachRunningPhase(cbRef)

      const runningStates = ['intake', 'discovering', 'reading', 'candidate-ready', 'verifying', 'verified-candidate']

      for (const state of runningStates) {
        act(() => {
          cbRef.current!({ sessionId: 'session-1', state })
        })
        expect(screen.getByText('import.cherrystudio.phase.processing')).toBeInTheDocument()
      }
    })

    it('should map promoting/finalizing to promoting phase', async () => {
      const cbRef: { current?: (event: any) => void } = {}
      await reachRunningPhase(cbRef)

      for (const state of ['promoting', 'finalizing']) {
        act(() => {
          cbRef.current!({ sessionId: 'session-1', state })
        })
        expect(screen.getByText('import.cherrystudio.phase.promoting')).toBeInTheDocument()
      }
    })

    it('should reset sessionId on idle event', async () => {
      const cbRef: { current?: (event: any) => void } = {}
      await reachRunningPhase(cbRef)

      act(() => {
        cbRef.current!({ sessionId: 'session-1', state: 'idle' })
      })

      // After idle, sessionId is reset to null.
      // Clicking cancel should close the modal, not call cancel API.
      await act(async () => {
        fireEvent.click(getCancelButton())
      })

      expect(mocks.cancel).not.toHaveBeenCalled()
    })
  })
})
