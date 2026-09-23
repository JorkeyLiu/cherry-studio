import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { getRouteResource } from '../routeResource'
import { scheduleIdleCallback } from '../scheduleIdleCallback'
import { useRouteIdlePreload } from '../useRouteIdlePreload'

const Harness = ({ importer, enabled }: { importer: () => Promise<{ default: () => null }>; enabled: boolean }) => {
  useRouteIdlePreload(importer, enabled)
  return null
}

describe('scheduleIdleCallback', () => {
  it('prefers requestIdleCallback without a forced timeout and is cancellable', () => {
    const cb = vi.fn()
    const requestSpy = vi.fn((fn: () => void) => {
      fn()
      return 7
    })
    const cancelSpy = vi.fn()
    vi.stubGlobal('requestIdleCallback', requestSpy)
    vi.stubGlobal('cancelIdleCallback', cancelSpy)

    const cancel = scheduleIdleCallback(cb)
    expect(requestSpy).toHaveBeenCalledTimes(1)
    expect(requestSpy.mock.calls[0]).toHaveLength(1)
    expect(cb).toHaveBeenCalledTimes(1)

    cancel()
    expect(cancelSpy).toHaveBeenCalledWith(7)

    vi.unstubAllGlobals()
  })

  it('falls back to an async cancellable timer when requestIdleCallback is missing', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestIdleCallback', undefined)
    const cb = vi.fn()
    const cancel = scheduleIdleCallback(cb)
    expect(cb).not.toHaveBeenCalled()
    cancel()
    vi.advanceTimersByTime(10)
    expect(cb).not.toHaveBeenCalled()

    const cb2 = vi.fn()
    scheduleIdleCallback(cb2)
    vi.advanceTimersByTime(10)
    expect(cb2).toHaveBeenCalledTimes(1)

    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
})

describe('useRouteIdlePreload', () => {
  it('does not schedule while disabled, schedules after stable, and cancels on unmount', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestIdleCallback', undefined)

    const Page = () => null
    const importer = vi.fn(() => Promise.resolve({ default: Page }))
    const resource = getRouteResource(importer)
    const preloadSpy = vi.spyOn(resource, 'preload')

    const { rerender, unmount } = render(<Harness importer={importer} enabled={false} />)
    vi.advanceTimersByTime(10)
    expect(preloadSpy).not.toHaveBeenCalled()
    expect(importer).not.toHaveBeenCalled()

    rerender(<Harness importer={importer} enabled={true} />)
    expect(preloadSpy).not.toHaveBeenCalled()

    unmount()
    vi.advanceTimersByTime(10)
    expect(preloadSpy).not.toHaveBeenCalled()
    expect(importer).not.toHaveBeenCalled()

    const { unmount: unmount2 } = render(<Harness importer={importer} enabled={true} />)
    vi.advanceTimersByTime(10)
    expect(preloadSpy).toHaveBeenCalledTimes(1)
    unmount2()

    preloadSpy.mockRestore()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('cancels a pending requestIdleCallback on unmount', () => {
    const callbacks: Array<() => void> = []
    const cancelSpy = vi.fn()
    vi.stubGlobal('requestIdleCallback', (fn: () => void) => {
      callbacks.push(fn)
      return 42
    })
    vi.stubGlobal('cancelIdleCallback', cancelSpy)

    const Page = () => null
    const importer = vi.fn(() => Promise.resolve({ default: Page }))

    const { unmount } = render(<Harness importer={importer} enabled={true} />)
    expect(callbacks).toHaveLength(1)
    expect(importer).not.toHaveBeenCalled()

    unmount()
    expect(cancelSpy).toHaveBeenCalledWith(42)
    expect(importer).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })
})
