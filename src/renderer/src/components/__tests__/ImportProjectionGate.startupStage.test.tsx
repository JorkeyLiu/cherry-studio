import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getImportProjectionReadinessState,
  resetImportProjectionReadiness,
  settleImportProjectionReadiness
} from '../../services/importProjectionReadiness'
import ImportProjectionGate from '../ImportProjectionGate'

describe('ImportProjectionGate with startupStage — preserves gate readiness/order', () => {
  beforeEach(() => {
    resetImportProjectionReadiness()
    vi.stubGlobal('__STARTUP_STAGE_ATTR__', 'false')
    delete (globalThis as any).process?.env?.STARTUP_STAGE_ATTR
  })

  it('remains gated while pending (loading) and reveals ordinary tree only on ready', async () => {
    const { rerender } = render(
      <ImportProjectionGate>
        <div data-testid="ordinary">ordinary</div>
      </ImportProjectionGate>
    )
    expect(screen.getByTestId('startup-readiness-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('ordinary')).not.toBeInTheDocument()

    // Simulate projection readiness settling to ready — should open gate
    settleImportProjectionReadiness('ready')
    // Need to trigger React update via re-render or wait for subscription
    rerender(
      <ImportProjectionGate>
        <div data-testid="ordinary">ordinary</div>
      </ImportProjectionGate>
    )
    expect(await screen.findByTestId('ordinary')).toBeInTheDocument()
    expect(getImportProjectionReadinessState()).toBe('ready')
  })

  it('shows retry surface on failed and stays gated', async () => {
    settleImportProjectionReadiness('failed')
    render(
      <ImportProjectionGate>
        <div data-testid="ordinary">ordinary</div>
      </ImportProjectionGate>
    )
    expect(screen.getByTestId('startup-readiness-error')).toBeInTheDocument()
    expect(screen.queryByTestId('ordinary')).not.toBeInTheDocument()
  })

  it('is idempotent: repeated ready settlements do not re-gate', () => {
    settleImportProjectionReadiness('ready')
    expect(getImportProjectionReadinessState()).toBe('ready')
    settleImportProjectionReadiness('failed')
    // first call wins, second is no-op
    expect(getImportProjectionReadinessState()).toBe('ready')
  })
})
