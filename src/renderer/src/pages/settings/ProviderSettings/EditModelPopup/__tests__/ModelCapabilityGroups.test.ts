import { INPUT_MODALITIES as SHARED_INPUT_MODALITIES } from '@renderer/utils/inputModalities'
import { describe, expect, it } from 'vitest'

import { hasKnownFeatures, hasKnownInputModalities, resolveInputModalityStates } from '../ModelCapabilityGroups'

describe('ModelCapabilityGroups shared normalization', () => {
  it('shares the canonical INPUT_MODALITIES order', () => {
    expect([...SHARED_INPUT_MODALITIES]).toEqual(['text', 'image', 'audio', 'video', 'pdf'])
  })

  it('maps unknown-only inputs to all-unknown (same truth as compact supported-only)', () => {
    expect(resolveInputModalityStates({ modalities: { input: ['sora-video'], output: ['text'] } } as never)).toEqual({
      text: 'unknown',
      image: 'unknown',
      audio: 'unknown',
      video: 'unknown',
      pdf: 'unknown'
    })
  })

  it('maps a known non-empty set to supported/unsupported with unknown values ignored', () => {
    expect(
      resolveInputModalityStates({ modalities: { input: ['text', 'IMAGE', 'sora-video'], output: [] } } as never)
    ).toEqual({
      text: 'supported',
      image: 'supported',
      audio: 'unsupported',
      video: 'unsupported',
      pdf: 'unsupported'
    })
  })

  it('detects group visibility: a group hides when it carries no known item', () => {
    expect(hasKnownInputModalities(undefined)).toBe(false)
    expect(hasKnownInputModalities({ modalities: { input: [], output: [] } } as never)).toBe(false)
    expect(hasKnownInputModalities({ modalities: { input: ['sora-video'], output: [] } } as never)).toBe(false)
    expect(hasKnownInputModalities({ modalities: { input: ['text'], output: [] } } as never)).toBe(true)

    expect(hasKnownFeatures(undefined)).toBe(false)
    expect(hasKnownFeatures({ modalities: { input: [], output: [] } } as never)).toBe(false)
    expect(hasKnownFeatures({ reasoning: true } as never)).toBe(true)
    expect(hasKnownFeatures({ toolCall: false } as never)).toBe(true)
    expect(hasKnownFeatures({ structuredOutput: false } as never)).toBe(true)
    expect(hasKnownFeatures({ temperature: true } as never)).toBe(true)
  })
})
