/**
 * CherryStudioImportPopup — L2 Cherry Studio ZIP compatibility-import UI.
 *
 * Provides the user-facing dialog for selecting a Cherry Studio ZIP backup,
 * confirming the replace-all warning, starting the import, observing
 * progress/status, requesting cancellation, and surfacing errors.
 *
 * Design constraints:
 * - Semantically distinct from L3 Backup_Restore (LOCK-6001).
 * - Replace-all semantics with explicit confirmation (LOCK-6002).
 * - Does not bypass startImport (LOCK-6003).
 * - macOS-first platform gate (LOCK-6004).
 * - Uses i18n for all user-visible strings (LOCK-6006).
 * - Uses existing Ant Design patterns and TopView popup pattern.
 */

import { loggerService } from '@logger'
import { Alert, Modal, Progress, Space, Steps, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { TopView } from '../TopView'

const logger = loggerService.withContext('CherryStudioImportPopup')

const { Text } = Typography

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PopupResult {
  success?: boolean
}

interface Props {
  resolve: (data: PopupResult) => void
}

type UIPhase =
  | 'selecting'
  | 'confirming'
  | 'starting'
  | 'running'
  | 'promoting'
  | 'success'
  | 'error'
  | 'cancelled'
  | 'unsupported'

// ---------------------------------------------------------------------------
// Step labels for the progress indicator
// ---------------------------------------------------------------------------

function getStepItems(t: ReturnType<typeof useTranslation>['t'], phase: UIPhase) {
  const isRunning = (p: string): 'wait' | 'process' | 'finish' => {
    const runningStates = ['starting', 'running', 'promoting']
    if (phase === p) return 'process'
    if (runningStates.includes(phase) && runningStates.indexOf(phase) > runningStates.indexOf(p)) return 'finish'
    if (phase === 'success') return 'finish'
    return 'wait'
  }

  return [
    {
      title: t('import.cherrystudio.steps.select'),
      status: isRunning('selecting')
    },
    {
      title: t('import.cherrystudio.steps.confirm'),
      status: isRunning('confirming')
    },
    {
      title: t('import.cherrystudio.steps.import'),
      status: isRunning('starting')
    },
    {
      title: t('import.cherrystudio.steps.promote'),
      status: isRunning('promoting')
    }
  ]
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const PopupContainer: React.FC<Props> = ({ resolve }) => {
  const [open, setOpen] = useState(true)
  const [phase, setPhase] = useState<UIPhase>('selecting')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [platformSupported, setPlatformSupported] = useState<boolean | null>(null)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const cancelRequestedRef = useRef(false)
  const { t } = useTranslation()

  // Check platform support on mount
  useEffect(() => {
    void window.api.cherryImport.getPlatformSupport().then((result) => {
      setPlatformSupported(result.supported)
      if (!result.supported) {
        setPhase('unsupported')
      }
    })
  }, [])

  // Listen for status changes from Main
  useEffect(() => {
    const removeListener = window.api.cherryImport.onStatusChanged((event) => {
      logger.debug('Status changed')
      switch (event.state) {
        case 'intake':
        case 'discovering':
        case 'reading':
        case 'candidate-ready':
        case 'verifying':
        case 'verified-candidate':
          setPhase('running')
          break
        case 'promoting':
        case 'finalizing':
          setPhase('promoting')
          break
        case 'promoted':
          setPhase('success')
          break
        case 'cancelled':
          setPhase('cancelled')
          break
        case 'error':
        case 'verification-failed':
        case 'promotion-failed':
          setPhase('error')
          setErrorMessage(event.error || t('import.cherrystudio.error.unknown'))
          break
        case 'idle':
          // Session ended, reset
          setSessionId(null)
          break
      }
    })

    return () => {
      removeListener()
    }
  }, [t])

  // --- Actions ---

  const handleSelectFile = async () => {
    setPhase('selecting')
    setErrorMessage(null)

    try {
      const file = await window.api.file.open({
        filters: [{ name: 'Cherry Studio Backup', extensions: ['zip'] }],
        title: t('import.cherrystudio.select_file')
      })

      if (!file) {
        return // User cancelled file selection
      }

      // Show confirmation dialog
      setPhase('confirming')
      // Store the selected file path for later use
      setSelectedFilePath(file.filePath)
    } catch (error) {
      logger.error('File selection failed:', error as Error)
      setPhase('selecting')
    }
  }

  const handleConfirmImport = async () => {
    // Use the stored file path from the initial selection
    if (!selectedFilePath) {
      setPhase('selecting')
      return
    }

    cancelRequestedRef.current = false
    setPhase('starting')
    setErrorMessage(null)

    try {
      // Start the import
      const result = await window.api.cherryImport.start(selectedFilePath)

      if (!result.ok) {
        setPhase('error')
        setErrorMessage(result.error || t('import.cherrystudio.error.unknown'))
        return
      }

      // Check if cancel was requested while start was in flight (LOCK-6005)
      if (cancelRequestedRef.current) {
        // Immediately cancel the newly created session
        if (result.sessionId) {
          const cancelResult = await window.api.cherryImport.cancel(result.sessionId)
          if (cancelResult.ok) {
            setPhase('cancelled')
          } else {
            setPhase('error')
            setErrorMessage(t('import.cherrystudio.error.unknown'))
          }
        } else {
          setPhase('cancelled')
        }
        return
      }

      setSessionId(result.sessionId ?? null)
      setPhase('running')
    } catch (error) {
      logger.error('Import start failed:', error as Error)
      setPhase('error')
      setErrorMessage(t('import.cherrystudio.error.unknown'))
    }
  }

  const handleCancel = async () => {
    if (!sessionId) {
      // During starting phase (before session exists), mark cancel intent.
      // The start handler will check this and cancel after session creation.
      if (phase === 'starting') {
        cancelRequestedRef.current = true
        return
      }
      // No session and not starting — just close
      setOpen(false)
      return
    }

    try {
      const result = await window.api.cherryImport.cancel(sessionId)
      if (result.ok) {
        setPhase('cancelled')
      } else {
        logger.warn('Cancel failed', { error: result.error })
      }
    } catch (error) {
      logger.error('Cancel request failed:', error as Error)
    }
  }

  const handleOk = () => {
    if (phase === 'selecting') {
      void handleSelectFile()
    } else if (phase === 'confirming') {
      void handleConfirmImport()
    }
  }

  const onCancel = () => {
    if (phase === 'running' || phase === 'starting' || phase === 'promoting') {
      void handleCancel()
    } else {
      setOpen(false)
    }
  }

  const onClose = () => {
    resolve({ success: phase === 'success' })
  }

  // Deduplicate: assign hide to the class-level static
  CherryStudioImportPopup.hide = onCancel

  // --- Render ---

  const isBusy = phase === 'starting' || phase === 'running' || phase === 'promoting'
  const canSelect = phase === 'selecting' || phase === 'confirming'
  const isTerminal = phase === 'success' || phase === 'error' || phase === 'cancelled' || phase === 'unsupported'

  const getOkText = () => {
    switch (phase) {
      case 'selecting':
        return t('import.cherrystudio.select_button')
      case 'confirming':
        return t('import.cherrystudio.confirm_button')
      default:
        return t('import.cherrystudio.select_button')
    }
  }

  const getPhaseLabel = () => {
    switch (phase) {
      case 'starting':
        return t('import.cherrystudio.phase.extracting')
      case 'running':
        return t('import.cherrystudio.phase.processing')
      case 'promoting':
        return t('import.cherrystudio.phase.promoting')
      case 'success':
        return t('import.cherrystudio.phase.success')
      case 'error':
        return t('import.cherrystudio.phase.error')
      case 'cancelled':
        return t('import.cherrystudio.phase.cancelled')
      case 'unsupported':
        return t('import.cherrystudio.phase.unsupported')
      default:
        return t('import.cherrystudio.phase.idle')
    }
  }

  return (
    <Modal
      title={t('import.cherrystudio.title')}
      open={open}
      onOk={canSelect ? handleOk : undefined}
      onCancel={onCancel}
      afterClose={onClose}
      okText={getOkText()}
      okButtonProps={{
        disabled: isTerminal,
        loading: isBusy
      }}
      cancelButtonProps={{
        disabled: phase === 'selecting' || phase === 'unsupported'
      }}
      maskClosable={false}
      transitionName="animation-move-down"
      centered
      width={520}>
      {/* Platform unsupported */}
      {phase === 'unsupported' && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            message={t('import.cherrystudio.unsupported.title')}
            description={t('import.cherrystudio.unsupported.description', {
              platform: platformSupported === false ? '' : ''
            })}
            type="warning"
            showIcon
          />
        </Space>
      )}

      {/* Selecting state */}
      {phase === 'selecting' && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>{t('import.cherrystudio.description')}</div>
          <Alert
            message={t('import.cherrystudio.warning.title')}
            description={t('import.cherrystudio.warning.description')}
            type="warning"
            showIcon
            style={{ marginTop: 12 }}
          />
        </Space>
      )}

      {/* Confirming state */}
      {phase === 'confirming' && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            message={t('import.cherrystudio.confirm_title')}
            description={
              <div>
                <p>{t('import.cherrystudio.confirm_description')}</p>
                <p>
                  <Text strong style={{ color: 'var(--color-error)' }}>
                    {t('import.cherrystudio.confirm_warning')}
                  </Text>
                </p>
              </div>
            }
            type="warning"
            showIcon
          />
        </Space>
      )}

      {/* Running state */}
      {(phase === 'starting' || phase === 'running' || phase === 'promoting') && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Steps size="small" items={getStepItems(t, phase)} />
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <Progress percent={100} status="active" strokeColor="var(--color-primary)" showInfo={false} />
            <div style={{ marginTop: 12 }}>{getPhaseLabel()}</div>
          </div>
        </Space>
      )}

      {/* Success state */}
      {phase === 'success' && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            message={t('import.cherrystudio.success.title')}
            description={t('import.cherrystudio.success.description')}
            type="success"
            showIcon
          />
        </Space>
      )}

      {/* Error state */}
      {phase === 'error' && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            message={t('import.cherrystudio.error.title')}
            description={errorMessage || t('import.cherrystudio.error.unknown')}
            type="error"
            showIcon
          />
        </Space>
      )}

      {/* Cancelled state */}
      {phase === 'cancelled' && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            message={t('import.cherrystudio.cancelled.title')}
            description={t('import.cherrystudio.cancelled.description')}
            type="info"
            showIcon
          />
        </Space>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Popup class (same pattern as ImportPopup, BackupPopup)
// ---------------------------------------------------------------------------

const TopViewKey = 'CherryStudioImportPopup'

export default class CherryStudioImportPopup {
  static topviewId = 0
  static hide() {
    TopView.hide(TopViewKey)
  }
  static show() {
    return new Promise<PopupResult>((resolve) => {
      TopView.show(
        <PopupContainer
          resolve={(v) => {
            resolve(v)
            TopView.hide(TopViewKey)
          }}
        />,
        TopViewKey
      )
    })
  }
}
