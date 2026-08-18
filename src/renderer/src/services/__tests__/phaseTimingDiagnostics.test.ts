import { describe, expect, it } from 'vitest'

import {
  clearActivePhaseCorrelation,
  currentPhaseCorrelation,
  isPhaseAttrEnabled,
  readPhaseRendererState,
  recordPhaseDurationForCorrelation,
  resetPhaseRendererState,
  setActivePhaseCorrelation
} from '../phaseTimingDiagnostics'

describe('renderer phase timing diagnostics', () => {
  it('is inert and preserves the disabled semantic path', () => {
    resetPhaseRendererState()
    setActivePhaseCorrelation('opaque', 'echo')
    recordPhaseDurationForCorrelation('opaque', 'echo', 'echo.userDispatch', 1)
    clearActivePhaseCorrelation()
    expect(isPhaseAttrEnabled()).toBe(false)
    expect(currentPhaseCorrelation()).toBeUndefined()
    expect(readPhaseRendererState().records).toEqual([])
  })
})
