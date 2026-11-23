import { describe, expect, it, vi } from 'vitest'

import { type MinimumSizeWindow, setMinimumSizeEnsuringBounds } from '../windowBounds'

const createWindow = (size: [number, number]) => {
  let current: [number, number] = size
  let minimum: [number, number] = [0, 0]
  const window: MinimumSizeWindow = {
    getSize: () => [current[0], current[1]],
    setMinimumSize: (width, height) => {
      minimum = [width, height]
    },
    setSize: (width, height) => {
      current = [width, height]
    }
  }
  return {
    window,
    minimum: () => minimum,
    current: () => current
  }
}

describe('setMinimumSizeEnsuringBounds', () => {
  it('raises the floor and grows a window that sits below it', () => {
    const harness = createWindow([520, 700])
    const result = setMinimumSizeEnsuringBounds(harness.window, 1011, 600, [960, 600])
    expect(harness.minimum()).toEqual([1011, 600])
    expect(result).toEqual([1011, 700])
    // Grown only to the floor; the height is left untouched.
    expect(harness.current()).toEqual([1011, 700])
  })

  it('never shrinks a window that already satisfies the floor', () => {
    const harness = createWindow([1790, 900])
    const setSize = vi.spyOn(harness.window, 'setSize')
    const result = setMinimumSizeEnsuringBounds(harness.window, 1011, 600, [960, 600])
    expect(harness.minimum()).toEqual([1011, 600])
    expect(result).toEqual([1790, 900])
    expect(setSize).not.toHaveBeenCalled()
    expect(harness.current()).toEqual([1790, 900])
  })

  it('keeps the reset policy when the request is not a usable size', () => {
    const harness = createWindow([520, 700])
    const result = setMinimumSizeEnsuringBounds(harness.window, Number.NaN, 0, [960, 600])
    expect(harness.minimum()).toEqual([960, 600])
    expect(result).toEqual([960, 700])
  })
})
