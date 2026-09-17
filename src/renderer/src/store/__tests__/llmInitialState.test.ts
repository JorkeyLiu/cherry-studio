/**
 * Fresh bootstrap contract (slice 1): the initial llm state contains no
 * built-in/system provider instances and no default model. Custom
 * connections are the only bootstrap path — nothing is pre-configured or
 * silently substituted.
 */
import { describe, expect, it } from 'vitest'

import { initialState } from '../llm'

describe('llm fresh initial state', () => {
  it('contains no providers', () => {
    expect(initialState.providers).toEqual([])
  })

  it('contains no default model', () => {
    expect(initialState.defaultModel).toBeUndefined()
  })
})
