import type { Model } from '@renderer/types'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelTagFilter } from '../filters'

const mocks = vi.hoisted(() => ({ supportsInputModality: vi.fn() }))

vi.mock('@renderer/utils/inputModalities', () => ({
  supportsInputModality: mocks.supportsInputModality
}))

function createModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'm1',
    provider: 'openai',
    name: 'Model-1',
    group: 'default',
    ...overrides
  }
}

describe('useModelTagFilter (five input modalities)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.supportsInputModality.mockReturnValue(false)
  })

  it('should have all modalities unselected initially', () => {
    const { result } = renderHook(() => useModelTagFilter())

    expect(result.current.tagSelection).toEqual({
      text: false,
      image: false,
      audio: false,
      video: false,
      pdf: false
    })
    expect(result.current.selectedTags).toEqual([])
  })

  it('should toggle a modality state', () => {
    const { result } = renderHook(() => useModelTagFilter())

    act(() => result.current.toggleTag('image'))
    expect(result.current.tagSelection.image).toBe(true)
    expect(result.current.selectedTags).toEqual(['image'])

    act(() => result.current.toggleTag('image'))
    expect(result.current.tagSelection.image).toBe(false)
    expect(result.current.selectedTags).toEqual([])
  })

  it('should reset all modalities to false', () => {
    const { result } = renderHook(() => useModelTagFilter())

    act(() => result.current.toggleTag('text'))
    act(() => result.current.toggleTag('pdf'))
    expect(result.current.selectedTags.sort()).toEqual(['pdf', 'text'])

    act(() => result.current.resetTags())
    expect(result.current.selectedTags).toEqual([])
    expect(Object.values(result.current.tagSelection).every((v) => v === false)).toBe(true)
  })

  it('tagFilter returns true when no modalities selected', () => {
    const { result } = renderHook(() => useModelTagFilter())
    const model = createModel()
    const passed = result.current.tagFilter(model)
    expect(passed).toBe(true)
    expect(mocks.supportsInputModality).not.toHaveBeenCalled()
  })

  it('tagFilter uses single selected modality predicate with provider', () => {
    const { result } = renderHook(() => useModelTagFilter())
    const model = createModel()
    const provider = { id: 'openai' } as never

    mocks.supportsInputModality.mockReturnValueOnce(true)
    act(() => result.current.toggleTag('audio'))

    const ok = result.current.tagFilter(model, provider)
    expect(ok).toBe(true)
    expect(mocks.supportsInputModality).toHaveBeenCalledTimes(1)
    expect(mocks.supportsInputModality).toHaveBeenCalledWith(model, 'audio', provider)
  })

  it('tagFilter requires all selected modalities to match (AND logic)', () => {
    const { result } = renderHook(() => useModelTagFilter())
    const model = createModel()

    act(() => result.current.toggleTag('text'))
    act(() => result.current.toggleTag('image'))

    mocks.supportsInputModality.mockReturnValueOnce(true).mockReturnValueOnce(false)
    expect(result.current.tagFilter(model)).toBe(false)

    mocks.supportsInputModality.mockReturnValueOnce(true).mockReturnValueOnce(true)
    expect(result.current.tagFilter(model)).toBe(true)
  })

  it('tagFilter excludes unknown entries (predicate false)', () => {
    const { result } = renderHook(() => useModelTagFilter())
    mocks.supportsInputModality.mockReturnValue(false)
    act(() => result.current.toggleTag('video'))
    expect(result.current.tagFilter(createModel())).toBe(false)
  })
})
