import type { Model, Provider } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getInputModalityAvailability,
  getInputModalityAvailabilityFromProviders,
  getNormalizedInputModalitySet,
  getSupportedInputModalities,
  getSupportedInputModalitiesForDisplay,
  isKnownInputModality,
  normalizeInputModalityValues,
  resolveSupportedInputModalities,
  supportsInputModality,
  supportsInputModalityForDisplay
} from '../inputModalities'

const mocks = vi.hoisted(() => ({ getExternalModelEntry: vi.fn(), getModelMetadataForDisplay: vi.fn() }))

vi.mock('@renderer/config/models/modelMetadata', () => ({
  getExternalModelEntry: mocks.getExternalModelEntry,
  getModelMetadataForDisplay: mocks.getModelMetadataForDisplay
}))

const baseModel = { id: 'm1', provider: 'a', name: 'M1', group: 'g' } as Model
const providerA = { id: 'a', type: 'anthropic' } as unknown as Provider
const providerB = { id: 'b', type: 'openai' } as unknown as Provider

function effective(modalitiesInput: string[]) {
  return { effective: { modalities: { input: modalitiesInput, output: ['text'] } }, source: 'canonical' as const }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getExternalModelEntry.mockReturnValue(undefined)
  mocks.getModelMetadataForDisplay.mockReturnValue({ source: 'none' })
})

describe('resolveSupportedInputModalities (pure entry projection)', () => {
  it('returns zero modalities when the entry is unknown', () => {
    expect(resolveSupportedInputModalities(undefined)).toEqual([])
    expect(resolveSupportedInputModalities(null)).toEqual([])
    expect(resolveSupportedInputModalities({ modalities: { input: [], output: [] } } as never)).toEqual([])
  })

  it('returns only text and image for input=[text,image]', () => {
    expect(
      resolveSupportedInputModalities({ modalities: { input: ['text', 'image'], output: ['text'] } } as never)
    ).toEqual(['text', 'image'])
  })

  it('renders audio/video/pdf when explicitly supported', () => {
    expect(
      resolveSupportedInputModalities({
        modalities: { input: ['text', 'audio', 'video', 'pdf'], output: ['text'] }
      } as never)
    ).toEqual(['text', 'audio', 'video', 'pdf'])
  })

  it('ignores unknown values and unsupported-by-absence values', () => {
    expect(
      resolveSupportedInputModalities({
        modalities: { input: ['text', 'sora-video', 'IMAGE'], output: ['text'] }
      } as never)
    ).toEqual(['text', 'image'])
  })
})

describe('getSupportedInputModalities (canonical-only)', () => {
  it('returns zero modalities when no exact entry matches', () => {
    expect(getSupportedInputModalities(baseModel)).toEqual([])
    expect(mocks.getExternalModelEntry).toHaveBeenCalledWith(baseModel, undefined)
  })

  it('passes the explicit provider through for precise resolution', () => {
    mocks.getExternalModelEntry.mockReturnValue({ modalities: { input: ['text'], output: ['text'] } })
    expect(getSupportedInputModalities(baseModel, providerA)).toEqual(['text'])
    expect(mocks.getExternalModelEntry).toHaveBeenCalledWith(baseModel, providerA)
  })
})

describe('supportsInputModality (canonical-only)', () => {
  it('is true only for explicitly supported values', () => {
    mocks.getExternalModelEntry.mockReturnValue({ modalities: { input: ['text', 'image'], output: ['text'] } })
    expect(supportsInputModality(baseModel, 'text')).toBe(true)
    expect(supportsInputModality(baseModel, 'image')).toBe(true)
    expect(supportsInputModality(baseModel, 'audio')).toBe(false)
    expect(supportsInputModality(baseModel, 'pdf')).toBe(false)
  })
})

describe('getSupportedInputModalitiesForDisplay (serving wins, canonical fills gaps)', () => {
  it('returns zero when both serving and canonical unknown (effective absent)', () => {
    mocks.getModelMetadataForDisplay.mockReturnValue({ source: 'none' })
    expect(getSupportedInputModalitiesForDisplay(baseModel)).toEqual([])
    expect(mocks.getModelMetadataForDisplay).toHaveBeenCalledWith(baseModel, undefined)
  })

  it('returns serving-only modalities: image/audio/pdf cases', () => {
    mocks.getModelMetadataForDisplay.mockReturnValue({
      source: 'serving',
      serving: { id: 'm1', modalities: { input: ['image'], output: ['text'] } },
      effective: { id: 'm1', modalities: { input: ['image'], output: ['text'] } } as never
    })
    expect(getSupportedInputModalitiesForDisplay(baseModel, providerA)).toEqual(['image'])

    mocks.getModelMetadataForDisplay.mockReturnValue({
      source: 'serving',
      serving: { id: 'm1', modalities: { input: ['audio'], output: ['text'] } },
      effective: { id: 'm1', modalities: { input: ['audio'], output: ['text'] } } as never
    })
    expect(getSupportedInputModalitiesForDisplay(baseModel, providerA)).toEqual(['audio'])

    mocks.getModelMetadataForDisplay.mockReturnValue({
      source: 'serving',
      serving: { id: 'm1', modalities: { input: ['pdf'], output: ['text'] } },
      effective: { id: 'm1', modalities: { input: ['pdf'], output: ['text'] } } as never
    })
    expect(getSupportedInputModalitiesForDisplay(baseModel, providerA)).toEqual(['pdf'])
  })

  it('returns canonical-only when serving absent (fallback)', () => {
    mocks.getModelMetadataForDisplay.mockReturnValue({
      source: 'canonical',
      canonical: { id: 'm1', modalities: { input: ['text', 'image'], output: ['text'] } } as never,
      effective: { id: 'm1', modalities: { input: ['text', 'image'], output: ['text'] } } as never
    })
    expect(getSupportedInputModalitiesForDisplay(baseModel)).toEqual(['text', 'image'])
  })

  it('mixed: serving wins over canonical', () => {
    // canonical offers text+image, serving offers text+audio => effective should be serving's set
    mocks.getModelMetadataForDisplay.mockReturnValue({
      source: 'mixed',
      canonical: { id: 'm1', modalities: { input: ['text', 'image'], output: ['text'] } } as never,
      serving: { id: 'm1', modalities: { input: ['text', 'audio'], output: ['text'] } } as never,
      effective: { id: 'm1', modalities: { input: ['text', 'audio'], output: ['text'] } } as never
    })
    expect(getSupportedInputModalitiesForDisplay(baseModel, providerA)).toEqual(['text', 'audio'])
  })

  it('serving provider mismatch falls back to canonical (effective is canonical)', () => {
    // Simulate getModelMetadataForDisplay already resolved mismatch → canonical effective
    mocks.getModelMetadataForDisplay.mockReturnValue({
      source: 'canonical',
      canonical: { id: 'm1', modalities: { input: ['text', 'video'], output: ['text'] } } as never,
      serving: undefined,
      effective: { id: 'm1', modalities: { input: ['text', 'video'], output: ['text'] } } as never
    })
    expect(getSupportedInputModalitiesForDisplay(baseModel, providerB)).toEqual(['text', 'video'])
    expect(mocks.getModelMetadataForDisplay).toHaveBeenCalledWith(baseModel, providerB)
  })

  it('passes explicit provider through for exact attribution', () => {
    mocks.getModelMetadataForDisplay.mockReturnValue(effective(['text']))
    expect(getSupportedInputModalitiesForDisplay(baseModel, providerA)).toEqual(['text'])
    expect(mocks.getModelMetadataForDisplay).toHaveBeenCalledWith(baseModel, providerA)
  })

  it('does not read legacy Model.capabilities (effective only)', () => {
    const legacyModel = { ...baseModel, capabilities: [{ name: 'vision' }] } as unknown as Model
    mocks.getModelMetadataForDisplay.mockReturnValue({ source: 'none' })
    expect(getSupportedInputModalitiesForDisplay(legacyModel, providerA)).toEqual([])
    // legacy capabilities must not influence effective
    expect(mocks.getModelMetadataForDisplay).toHaveBeenCalledWith(legacyModel, providerA)
  })
})

describe('supportsInputModalityForDisplay', () => {
  it('is true only for effective supported values', () => {
    mocks.getModelMetadataForDisplay.mockReturnValue(effective(['text', 'image']))
    expect(supportsInputModalityForDisplay(baseModel, 'text')).toBe(true)
    expect(supportsInputModalityForDisplay(baseModel, 'image')).toBe(true)
    expect(supportsInputModalityForDisplay(baseModel, 'audio')).toBe(false)
    expect(supportsInputModalityForDisplay(baseModel, 'pdf')).toBe(false)
  })

  it('reflects serving-only modalities', () => {
    mocks.getModelMetadataForDisplay.mockReturnValue(effective(['audio', 'pdf']))
    expect(supportsInputModalityForDisplay(baseModel, 'audio')).toBe(true)
    expect(supportsInputModalityForDisplay(baseModel, 'pdf')).toBe(true)
    expect(supportsInputModalityForDisplay(baseModel, 'image')).toBe(false)
  })
})

describe('getInputModalityAvailability (display-layer)', () => {
  it('is all false for unknown-only lists', () => {
    mocks.getModelMetadataForDisplay.mockReturnValue({ source: 'none' })
    expect(getInputModalityAvailability([baseModel])).toEqual({
      text: false,
      image: false,
      audio: false,
      video: false,
      pdf: false
    })
  })

  it('marks only exactly supported modalities (serving-aware)', () => {
    mocks.getModelMetadataForDisplay.mockImplementation((model: Model) => {
      if (model.id === 'm1') return effective(['text', 'image'])
      if (model.id === 'm2') return effective(['text', 'audio'])
      return { source: 'none' }
    })
    const m2 = { ...baseModel, id: 'm2' }
    expect(getInputModalityAvailability([baseModel, m2])).toEqual({
      text: true,
      image: true,
      audio: true,
      video: false,
      pdf: false
    })
  })

  it('resolves provider refs exactly via display helper', () => {
    mocks.getModelMetadataForDisplay.mockReturnValue(effective(['text', 'pdf']))
    expect(getInputModalityAvailabilityFromProviders([{ ...providerA, models: [baseModel] } as Provider])).toEqual({
      text: true,
      image: false,
      audio: false,
      video: false,
      pdf: true
    })
    expect(mocks.getModelMetadataForDisplay).toHaveBeenCalledWith(baseModel, expect.objectContaining({ id: 'a' }))
  })

  it('available filter reflects serving-only image/audio/pdf', () => {
    mocks.getModelMetadataForDisplay.mockImplementation((model: Model) => {
      if (model.id === 'serving-image') return effective(['image'])
      if (model.id === 'serving-audio') return effective(['audio'])
      if (model.id === 'serving-pdf') return effective(['pdf'])
      return { source: 'none' }
    })
    const s1 = { ...baseModel, id: 'serving-image' }
    const s2 = { ...baseModel, id: 'serving-audio' }
    const s3 = { ...baseModel, id: 'serving-pdf' }
    expect(getInputModalityAvailability([s1, s2, s3])).toEqual({
      text: false,
      image: true,
      audio: true,
      video: false,
      pdf: true
    })
  })

  it('mixed serving wins reflected in availability', () => {
    // m1: canonical text+image but serving text+audio => effective text+audio
    mocks.getModelMetadataForDisplay.mockReturnValue(effective(['text', 'audio']))
    expect(getInputModalityAvailability([baseModel])).toEqual({
      text: true,
      image: false,
      audio: true,
      video: false,
      pdf: false
    })
  })
})

describe('shared normalization truth', () => {
  it('normalizes case/whitespace and drops unknown values', () => {
    expect(normalizeInputModalityValues([' TEXT ', 'IMAGE', 'sora-video', '', '  '])).toEqual(
      new Set(['text', 'image'])
    )
    expect(isKnownInputModality('text')).toBe(true)
    expect(isKnownInputModality('sora-video')).toBe(false)
  })

  it('treats unknown-only inputs as unknown (empty set)', () => {
    expect(getNormalizedInputModalitySet({ modalities: { input: ['sora-video'], output: [] } } as never)).toEqual(
      new Set()
    )
    expect(resolveSupportedInputModalities({ modalities: { input: ['sora-video'], output: [] } } as never)).toEqual([])
  })
})
