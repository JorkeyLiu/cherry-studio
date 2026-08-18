import { describe, expect, it } from 'vitest'

import {
  isPhaseAttrMainEnabled,
  readPhaseMainState,
  recordMainPhaseDuration,
  resetPhaseMainState
} from '../phaseTimingDiagnostics'

describe('Main phase timing diagnostics', () => {
  it('is inert in the default build', () => {
    resetPhaseMainState()
    recordMainPhaseDuration('opaque', 'echo', 'echo.mainAppend', 1)
    expect(isPhaseAttrMainEnabled()).toBe(false)
    expect(readPhaseMainState().records).toEqual([])
  })
})
