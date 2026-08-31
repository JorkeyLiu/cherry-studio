import { describe, expect, it, vi } from 'vitest'

import { AsyncInitializer } from '../asyncInitializer'

describe('AsyncInitializer', () => {
  it('should initialize value lazily on first get', async () => {
    const mockFactory = vi.fn().mockResolvedValue('test-value')
    const initializer = new AsyncInitializer(mockFactory)

    // factory 不应该在构造时调用
    expect(mockFactory).not.toHaveBeenCalled()

    // 第一次调用 get
    const result = await initializer.get()

    expect(mockFactory).toHaveBeenCalledTimes(1)
    expect(result).toBe('test-value')
  })

  it('should cache value and return same instance on subsequent calls', async () => {
    const mockFactory = vi.fn().mockResolvedValue('test-value')
    const initializer = new AsyncInitializer(mockFactory)

    // 多次调用 get
    const result1 = await initializer.get()
    const result2 = await initializer.get()
    const result3 = await initializer.get()

    // factory 只应该被调用一次
    expect(mockFactory).toHaveBeenCalledTimes(1)

    // 所有结果应该相同
    expect(result1).toBe('test-value')
    expect(result2).toBe('test-value')
    expect(result3).toBe('test-value')
  })

  it('should handle concurrent calls properly', async () => {
    let resolveFactory: (value: string) => void
    const factoryPromise = new Promise<string>((resolve) => {
      resolveFactory = resolve
    })
    const mockFactory = vi.fn().mockReturnValue(factoryPromise)

    const initializer = new AsyncInitializer(mockFactory)

    // 同时调用多次 get
    const promise1 = initializer.get()
    const promise2 = initializer.get()
    const promise3 = initializer.get()

    // factory 只应该被调用一次
    expect(mockFactory).toHaveBeenCalledTimes(1)

    // 解析 promise
    resolveFactory!('concurrent-value')

    const results = await Promise.all([promise1, promise2, promise3])
    expect(results).toEqual(['concurrent-value', 'concurrent-value', 'concurrent-value'])
  })

  it('should handle and cache errors', async () => {
    const error = new Error('Factory error')
    const mockFactory = vi.fn().mockRejectedValue(error)
    const initializer = new AsyncInitializer(mockFactory)

    // 多次调用都应该返回相同的错误
    await expect(initializer.get()).rejects.toThrow('Factory error')
    await expect(initializer.get()).rejects.toThrow('Factory error')

    // factory 只应该被调用一次
    expect(mockFactory).toHaveBeenCalledTimes(1)
  })

  it('should not retry after failure', async () => {
    // 确认错误被缓存，不会重试
    const error = new Error('Initialization failed')
    const mockFactory = vi.fn().mockRejectedValue(error)
    const initializer = new AsyncInitializer(mockFactory)

    // 第一次失败
    await expect(initializer.get()).rejects.toThrow('Initialization failed')

    // 第二次调用不应该重试
    await expect(initializer.get()).rejects.toThrow('Initialization failed')

    // factory 只被调用一次
    expect(mockFactory).toHaveBeenCalledTimes(1)
  })

  it('should expose status and support resetIfRejected to retry after failure', async () => {
    const err = new Error('first fail')
    const mockFactory = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce('retried-value')
    const initializer = new AsyncInitializer(mockFactory)

    expect(initializer.getStatus()).toBe('idle')
    await expect(initializer.get()).rejects.toThrow('first fail')
    expect(initializer.getStatus()).toBe('rejected')
    // without reset, still rejected
    await expect(initializer.get()).rejects.toThrow('first fail')
    expect(mockFactory).toHaveBeenCalledTimes(1)

    // supported retry: clear rejected
    expect(initializer.resetIfRejected()).toBe(true)
    expect(initializer.getStatus()).toBe('idle')
    const value = await initializer.get()
    expect(value).toBe('retried-value')
    expect(mockFactory).toHaveBeenCalledTimes(2)
    expect(initializer.getStatus()).toBe('fulfilled')
  })

  it('should not reset while pending and should preserve concurrent dedup', async () => {
    let resolveFactory: (v: string) => void
    const pending = new Promise<string>((res) => {
      resolveFactory = res
    })
    const mockFactory = vi.fn().mockReturnValue(pending)
    const initializer = new AsyncInitializer(mockFactory)

    const p1 = initializer.get()
    const p2 = initializer.get()
    expect(mockFactory).toHaveBeenCalledTimes(1)
    expect(initializer.getStatus()).toBe('pending')
    expect(initializer.isPending()).toBe(true)
    // resetIfRejected and reset should be no-op while pending
    expect(initializer.resetIfRejected()).toBe(false)
    expect(initializer.reset()).toBe(false)
    expect(initializer.getStatus()).toBe('pending')
    // still deduped
    resolveFactory!('ok')
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe('ok')
    expect(r2).toBe('ok')
    expect(initializer.getStatus()).toBe('fulfilled')
    // explicit reset after settlement should allow new init
    expect(initializer.reset()).toBe(true)
    expect(initializer.getStatus()).toBe('idle')
    // factory still is the same mock that resolved 'ok' previously; after reset next get should call factory again
    mockFactory.mockResolvedValue('second-value')
    const v2 = await initializer.get()
    expect(v2).toBe('second-value')
    expect(mockFactory).toHaveBeenCalledTimes(2)
  })

  it('should handle concurrent callers racing on rejected reset without duplicate factories', async () => {
    const err = new Error('fail')
    let rejectFactory: (e: Error) => void
    const firstPending = new Promise<string>((_, rej) => {
      rejectFactory = rej
    })
    const mockFactory = vi.fn().mockReturnValueOnce(firstPending).mockResolvedValueOnce('after-retry')
    const initializer = new AsyncInitializer<string>(mockFactory as any)

    const p1 = initializer.get()
    const p2 = initializer.get()
    expect(mockFactory).toHaveBeenCalledTimes(1)
    // reject pending
    rejectFactory!(err)
    await expect(p1).rejects.toThrow('fail')
    await expect(p2).rejects.toThrow('fail')
    expect(initializer.getStatus()).toBe('rejected')
    // two concurrent callers both try to reset and retry: only one factory call should happen for retry
    const didReset = initializer.resetIfRejected()
    expect(didReset).toBe(true)
    const retryP1 = initializer.get()
    // second caller dedupes on same pending retry
    const retryP2 = initializer.get()
    expect(mockFactory).toHaveBeenCalledTimes(2)
    const [rr1, rr2] = await Promise.all([retryP1, retryP2])
    expect(rr1).toBe('after-retry')
    expect(rr2).toBe('after-retry')
    // second reset attempt should be no-op because status is now fulfilled/pending not rejected
    expect(initializer.resetIfRejected()).toBe(false)
  })

  it('should keep fulfilled value cached without implicit retry and allow explicit reset', async () => {
    const mockFactory = vi.fn().mockResolvedValue('first')
    const initializer = new AsyncInitializer(mockFactory)
    const v1 = await initializer.get()
    expect(v1).toBe('first')
    expect(initializer.getStatus()).toBe('fulfilled')
    const v2 = await initializer.get()
    expect(v2).toBe('first')
    expect(mockFactory).toHaveBeenCalledTimes(1)
    // resetIfRejected should be false for fulfilled
    expect(initializer.resetIfRejected()).toBe(false)
    expect(initializer.getStatus()).toBe('fulfilled')
    // explicit reset should clear
    expect(initializer.reset()).toBe(true)
    expect(initializer.getStatus()).toBe('idle')
    mockFactory.mockResolvedValue('second')
    const v3 = await initializer.get()
    expect(v3).toBe('second')
    expect(mockFactory).toHaveBeenCalledTimes(2)
  })
})
