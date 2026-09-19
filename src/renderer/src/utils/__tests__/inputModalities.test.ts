import type { Model, Provider } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getInputModalityAvailability,
  getInputModalityAvailabilityFromProviders,
  getNormalizedInputModalitySet,
  getSupportedInputModalities,
  isKnownInputModality,
  normalizeInputModalityValues,
  resolveSupportedInputModalities,
  supportsInputModality
} from '../inputModalities'

const mocks = vi.hoisted(() => ({ getExternalModelEntry: vi.fn() }))

vi.mock('@renderer/config/models/modelMetadata', () => ({
  getExternalModelEntry: mocks.getExternalModelEntry
}))

const baseModel = { id: 'm1', provider: 'a', name: 'M1', group: 'g' } as Model
const providerA = { id: 'a', type: 'anthropic' } as unknown as Provider

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getExternalModelEntry.mockReturnValue(undefined)
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

describe('getSupportedInputModalities (exact provider attribution)', () => {
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

describe('supportsInputModality', () => {
  it('is true only for explicitly supported values', () => {
    mocks.getExternalModelEntry.mockReturnValue({ modalities: { input: ['text', 'image'], output: ['text'] } })
    expect(supportsInputModality(baseModel, 'text')).toBe(true)
    expect(supportsInputModality(baseModel, 'image')).toBe(true)
    expect(supportsInputModality(baseModel, 'audio')).toBe(false)
    expect(supportsInputModality(baseModel, 'pdf')).toBe(false)
  })
})

describe('getInputModalityAvailability', () => {
  it('is all false for unknown-only lists', () => {
    expect(getInputModalityAvailability([baseModel])).toEqual({
      text: false,
      image: false,
      audio: false,
      video: false,
      pdf: false
    })
  })

  it('marks only exactly supported modalities', () => {
    mocks.getExternalModelEntry.mockImplementation((model: Model) => {
      if (model.id === 'm1') return { modalities: { input: ['text', 'image'], output: ['text'] } }
      if (model.id === 'm2') return { modalities: { input: ['text', 'audio'], output: ['text'] } }
      return undefined
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

  it('resolves provider refs exactly', () => {
    mocks.getExternalModelEntry.mockReturnValue({ modalities: { input: ['text', 'pdf'], output: ['text'] } })
    expect(getInputModalityAvailabilityFromProviders([{ ...providerA, models: [baseModel] } as Provider])).toEqual({
      text: true,
      image: false,
      audio: false,
      video: false,
      pdf: true
    })
    expect(mocks.getExternalModelEntry).toHaveBeenCalledWith(baseModel, expect.objectContaining({ id: 'a' }))
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
