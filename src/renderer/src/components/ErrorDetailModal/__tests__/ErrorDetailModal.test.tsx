import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

/**
 * Focused tests for the error detail modal (AI diagnosis removed):
 *  - Raw error details (name/message/stack) still render.
 *  - The AI diagnosis button, section, loading/done/result states and their
 *    persistence are gone — no AI diagnosis UI exists anymore.
 *  - The modal has NO dependency on the deleted ErrorDiagnosisService: the
 *    mock factory below throws if anything in the module graph still imports
 *    `@renderer/services/ErrorDiagnosisService` (the file no longer exists).
 */

// Sentinel: if any module in the imported graph still references the deleted
// AI diagnosis service, vitest resolves this factory (and throws), failing the
// entire file. If nothing imports it, the mock is never instantiated.
vi.mock('@renderer/services/ErrorDiagnosisService', () => {
  throw new Error('ErrorDiagnosisService must not be imported by the error detail modal')
})

vi.mock('@renderer/components/CodeViewer', () => ({
  default: () => <div>code-viewer</div>
}))

vi.mock('@renderer/components/Popups/GeneralPopup', () => ({
  default: { show: vi.fn() }
}))

vi.mock('@renderer/context/CodeStyleProvider', () => ({
  useCodeStyle: () => ({ highlightCode: vi.fn().mockResolvedValue('') })
}))

vi.mock('@renderer/components/Scrollbar', () => ({
  default: ({ children, ...props }: any) => <div {...props}>{children}</div>
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { exists: () => false, language: 'en' }
  })
}))

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

vi.mock('antd', () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props} type="button">
      {children}
    </button>
  )
}))

import type { SerializedError } from '@renderer/types/error'

import { ErrorDetailContent } from '../index'

const makeError = (overrides: Partial<SerializedError> = {}): SerializedError => ({
  name: 'APICallError',
  message: 'invalid_api_key',
  stack: '  at foo (bar.js:1:1)',
  ...overrides
})

describe('ErrorDetailModal', () => {
  it('renders raw built-in error details (name, message, stack)', () => {
    const error = makeError()

    render(<ErrorDetailContent error={error} />)

    expect(screen.getByText('APICallError')).toBeTruthy()
    expect(screen.getByText('invalid_api_key')).toBeTruthy()
    // Stack renders inside a <pre>; match normalized content (leading
    // whitespace is collapsed by the testing-library text normalizer).
    expect(screen.getByText(/at foo \(bar\.js:1:1\)/)).toBeTruthy()
  })

  it('renders no AI diagnosis UI and keeps the copy button', () => {
    const error = makeError()

    render(<ErrorDetailContent error={error} />)

    // Copy button remains — generic error detail action.
    expect(screen.getByText('common.copy')).toBeTruthy()

    // No AI diagnosis button/status/section keys are rendered.
    expect(screen.queryByText('error.diagnosis.ai_button')).toBeNull()
    expect(screen.queryByText('error.diagnosis.ai_loading')).toBeNull()
    expect(screen.queryByText('error.diagnosis.ai_done')).toBeNull()
    expect(screen.queryByText('error.diagnosis.ai_result')).toBeNull()
  })

  it('renders raw details and the copy button even when the error is undefined', () => {
    render(<ErrorDetailContent />)

    expect(screen.getByText('error.unknown')).toBeTruthy()
    expect(screen.getByText('common.copy')).toBeTruthy()
  })
})
