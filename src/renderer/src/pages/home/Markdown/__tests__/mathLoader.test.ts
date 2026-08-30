import type * as RehypeKatex from 'rehype-katex'
import type * as RemarkMath from 'remark-math'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RemarkMathModule = typeof RemarkMath
type RehypeKatexModule = typeof RehypeKatex

function createLenientMock(fakeModule: Record<string, unknown>) {
  const base: Record<string, unknown> = {
    ...(fakeModule as object),
    __esModule: true,
    default: fakeModule
  }
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver)
      return undefined
    },
    has() {
      return true
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop in target) return Reflect.getOwnPropertyDescriptor(target, prop)
      return { configurable: true, enumerable: true, writable: true, value: undefined }
    },
    ownKeys(target) {
      return Reflect.ownKeys(target)
    }
  })
}

describe('mathLoader - S7.6 lazy math runtime', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('does not evaluate any math boundary on loader import, only after loadMathRuntime', async () => {
    const fakeRemark = { remarkMath: vi.fn() }
    const fakeRehype = { rehypeKatex: vi.fn() }
    let cssCount = 0
    let copyCount = 0
    let mhchemCount = 0
    let remarkCount = 0
    let rehypeCount = 0

    vi.doMock('katex/dist/katex.min.css', () => {
      cssCount += 1
      return {}
    })
    vi.doMock('katex/dist/contrib/copy-tex', () => {
      copyCount += 1
      return {}
    })
    vi.doMock('katex/dist/contrib/mhchem', () => {
      mhchemCount += 1
      return {}
    })
    vi.doMock('remark-math', () => {
      remarkCount += 1
      return createLenientMock(fakeRemark as unknown as Record<string, unknown>) as unknown as RemarkMathModule
    })
    vi.doMock('rehype-katex', () => {
      rehypeCount += 1
      return createLenientMock(fakeRehype as unknown as Record<string, unknown>) as unknown as RehypeKatexModule
    })

    const { loadMathRuntime } = await import('../mathLoader')
    expect(cssCount).toBe(0)
    expect(copyCount).toBe(0)
    expect(mhchemCount).toBe(0)
    expect(remarkCount).toBe(0)
    expect(rehypeCount).toBe(0)

    const runtime = await loadMathRuntime()
    expect(cssCount).toBe(1)
    expect(copyCount).toBe(1)
    expect(mhchemCount).toBe(1)
    expect(remarkCount).toBe(1)
    expect(rehypeCount).toBe(1)
    expect((runtime as unknown as { remarkMath: unknown }).remarkMath).toBeDefined()
  })

  it('loads in exact executable side-effect sequence CSS→copy-tex→mhchem→remark-math→rehype-katex', async () => {
    const order: string[] = []
    vi.doMock('katex/dist/katex.min.css', () => {
      order.push('css')
      return {}
    })
    vi.doMock('katex/dist/contrib/copy-tex', () => {
      order.push('copy')
      return {}
    })
    vi.doMock('katex/dist/contrib/mhchem', () => {
      order.push('mhchem')
      return {}
    })
    vi.doMock('remark-math', () => {
      order.push('remark')
      return createLenientMock({} as Record<string, unknown>) as unknown as RemarkMathModule
    })
    vi.doMock('rehype-katex', () => {
      order.push('rehype')
      return createLenientMock({} as Record<string, unknown>) as unknown as RehypeKatexModule
    })
    const { loadMathRuntime } = await import('../mathLoader')
    await loadMathRuntime()
    expect(order).toEqual(['css', 'copy', 'mhchem', 'remark', 'rehype'])
  })

  it('deduplicates concurrent loads - same promise and single import invocation', async () => {
    const fakeRemark = { remarkMath: vi.fn() }
    const fakeRehype = { rehypeKatex: vi.fn() }
    let cssCount = 0
    let copyCount = 0
    let mhchemCount = 0
    let remarkCount = 0
    let rehypeCount = 0

    vi.doMock('katex/dist/katex.min.css', () => {
      cssCount += 1
      return {}
    })
    vi.doMock('katex/dist/contrib/copy-tex', () => {
      copyCount += 1
      return {}
    })
    vi.doMock('katex/dist/contrib/mhchem', () => {
      mhchemCount += 1
      return {}
    })
    vi.doMock('remark-math', () => {
      remarkCount += 1
      return createLenientMock(fakeRemark as unknown as Record<string, unknown>) as unknown as RemarkMathModule
    })
    vi.doMock('rehype-katex', () => {
      rehypeCount += 1
      return createLenientMock(fakeRehype as unknown as Record<string, unknown>) as unknown as RehypeKatexModule
    })

    const { loadMathRuntime } = await import('../mathLoader')
    const p1 = loadMathRuntime()
    const p2 = loadMathRuntime()
    expect(p1).toBe(p2)

    const [m1, m2] = await Promise.all([p1, p2])
    expect(cssCount).toBe(1)
    expect(copyCount).toBe(1)
    expect(mhchemCount).toBe(1)
    expect(remarkCount).toBe(1)
    expect(rehypeCount).toBe(1)
    expect(m1).toBe(m2)

    const p3 = await loadMathRuntime()
    expect(p3).toBe(m1)
    expect(cssCount).toBe(1)
  })

  it('deduplicates subsequent success without new import', async () => {
    const fakeRemark = { remarkMath: vi.fn() }
    const fakeRehype = { rehypeKatex: vi.fn() }
    let cssCount = 0
    vi.doMock('katex/dist/katex.min.css', () => {
      cssCount += 1
      return {}
    })
    vi.doMock('katex/dist/contrib/copy-tex', () => ({}))
    vi.doMock('katex/dist/contrib/mhchem', () => ({}))
    vi.doMock(
      'remark-math',
      () => createLenientMock(fakeRemark as unknown as Record<string, unknown>) as unknown as RemarkMathModule
    )
    vi.doMock(
      'rehype-katex',
      () => createLenientMock(fakeRehype as unknown as Record<string, unknown>) as unknown as RehypeKatexModule
    )

    const { loadMathRuntime } = await import('../mathLoader')
    const first = await loadMathRuntime()
    expect(cssCount).toBe(1)
    const second = await loadMathRuntime()
    expect(second).toBe(first)
    expect(cssCount).toBe(1)
    const third = await loadMathRuntime()
    expect(third).toBe(first)
    expect(cssCount).toBe(1)
  })

  it('rejection does not poison cache - same loader instance retries and succeeds', async () => {
    const fakeRemark = { remarkMath: vi.fn() }
    const fakeRehype = { rehypeKatex: vi.fn() }
    let attempt = 0
    vi.doMock('katex/dist/katex.min.css', () => {
      attempt += 1
      if (attempt === 1) throw new Error('css failed')
      return {}
    })
    vi.doMock('katex/dist/contrib/copy-tex', () => ({}))
    vi.doMock('katex/dist/contrib/mhchem', () => ({}))
    vi.doMock(
      'remark-math',
      () => createLenientMock(fakeRemark as unknown as Record<string, unknown>) as unknown as RemarkMathModule
    )
    vi.doMock(
      'rehype-katex',
      () => createLenientMock(fakeRehype as unknown as Record<string, unknown>) as unknown as RehypeKatexModule
    )

    const { loadMathRuntime } = await import('../mathLoader')
    await expect(loadMathRuntime()).rejects.toThrow()
    expect(attempt).toBe(1)

    const mod = await loadMathRuntime()
    expect(attempt).toBe(2)
    expect((mod as unknown as { remarkMath: unknown }).remarkMath).toBeDefined()

    const again = await loadMathRuntime()
    expect(again).toBe(mod)
    expect(attempt).toBe(2)
  })

  it('concurrent rejection shares same rejected promise and same loader instance allows retry', async () => {
    const fakeRemark = { remarkMath: vi.fn() }
    const fakeRehype = { rehypeKatex: vi.fn() }
    let attempts = 0
    vi.doMock('katex/dist/katex.min.css', () => ({}))
    vi.doMock('katex/dist/contrib/copy-tex', () => ({}))
    vi.doMock('katex/dist/contrib/mhchem', () => ({}))
    vi.doMock('remark-math', () => {
      attempts += 1
      if (attempts === 1) throw new Error('remark failed')
      return createLenientMock(fakeRemark as unknown as Record<string, unknown>) as unknown as RemarkMathModule
    })
    vi.doMock(
      'rehype-katex',
      () => createLenientMock(fakeRehype as unknown as Record<string, unknown>) as unknown as RehypeKatexModule
    )

    const { loadMathRuntime } = await import('../mathLoader')

    const p1 = loadMathRuntime()
    const p2 = loadMathRuntime()
    expect(p1).toBe(p2)
    p2.catch(() => {})

    await expect(p1).rejects.toThrow()
    expect(attempts).toBe(1)

    const retry = await loadMathRuntime()
    expect(attempts).toBe(2)
    expect((retry as unknown as { remarkMath: unknown }).remarkMath).toBeDefined()

    const cached = await loadMathRuntime()
    expect(cached).toBe(retry)
    expect(attempts).toBe(2)
  })

  it('all five boundaries participate atomically - same loader instance retries and asserts ordered prefix, counts, cache stability', async () => {
    const fakeRemark = { remarkMath: vi.fn() }
    const fakeRehype = { rehypeKatex: vi.fn() }

    const boundaries = [
      'katex/dist/katex.min.css',
      'katex/dist/contrib/copy-tex',
      'katex/dist/contrib/mhchem',
      'remark-math',
      'rehype-katex'
    ] as const

    for (const failing of boundaries) {
      vi.resetModules()
      const order: string[] = []
      let cssCount = 0
      let copyCount = 0
      let mhchemCount = 0
      let remarkCount = 0
      let rehypeCount = 0

      vi.doMock('katex/dist/katex.min.css', () => {
        cssCount += 1
        order.push('css')
        if (failing === 'katex/dist/katex.min.css' && cssCount === 1) throw new Error('css fail')
        return {}
      })
      vi.doMock('katex/dist/contrib/copy-tex', () => {
        copyCount += 1
        order.push('copy')
        if (failing === 'katex/dist/contrib/copy-tex' && copyCount === 1) throw new Error('copy fail')
        return {}
      })
      vi.doMock('katex/dist/contrib/mhchem', () => {
        mhchemCount += 1
        order.push('mhchem')
        if (failing === 'katex/dist/contrib/mhchem' && mhchemCount === 1) throw new Error('mhchem fail')
        return {}
      })
      vi.doMock('remark-math', () => {
        remarkCount += 1
        order.push('remark')
        if (failing === 'remark-math' && remarkCount === 1) throw new Error('remark fail')
        return createLenientMock(fakeRemark as unknown as Record<string, unknown>) as unknown as RemarkMathModule
      })
      vi.doMock('rehype-katex', () => {
        rehypeCount += 1
        order.push('rehype')
        if (failing === 'rehype-katex' && rehypeCount === 1) throw new Error('rehype fail')
        return createLenientMock(fakeRehype as unknown as Record<string, unknown>) as unknown as RehypeKatexModule
      })

      const { loadMathRuntime } = await import('../mathLoader')
      await expect(loadMathRuntime()).rejects.toThrow()
      const failedOrder = [...order]

      // Retry with SAME loader instance, not a new import after resetModules
      const ok = await loadMathRuntime()
      expect((ok as unknown as { remarkMath: unknown }).remarkMath).toBeDefined()

      // Both attempts use same instance, so retry counts prefix + full success sequence
      // First failure order is prefix up to failing boundary inclusive
      const expectedFailPrefix: Record<string, string[]> = {
        'katex/dist/katex.min.css': ['css'],
        'katex/dist/contrib/copy-tex': ['css', 'copy'],
        'katex/dist/contrib/mhchem': ['css', 'copy', 'mhchem'],
        'remark-math': ['css', 'copy', 'mhchem', 'remark'],
        'rehype-katex': ['css', 'copy', 'mhchem', 'remark', 'rehype']
      }
      expect(failedOrder).toEqual(expectedFailPrefix[failing])

      // After retry, dynamic import caching means earlier successful boundaries are not re-executed.
      // Overall order = failed prefix + retry suffix starting at failing boundary.
      const shortNames = ['css', 'copy', 'mhchem', 'remark', 'rehype']
      const idx = boundaries.indexOf(failing)
      const suffix = shortNames.slice(idx)
      const fullOrder = [...failedOrder, ...suffix]
      expect(order).toEqual(fullOrder)

      // Assert retry counts with caching: earlier successes cached (1), failing retried (2), later once (1)
      const counts = [cssCount, copyCount, mhchemCount, remarkCount, rehypeCount]
      for (let i = 0; i < boundaries.length; i++) {
        if (i < idx) expect(counts[i]).toBe(1)
        else if (i === idx) expect(counts[i]).toBe(2)
        else expect(counts[i]).toBe(1)
      }

      // Post-success cache stability: further calls do not invoke factories again
      const snapshot = [...order]
      const cached = await loadMathRuntime()
      expect(cached).toBe(ok)
      expect(order).toEqual(snapshot)
      expect(cssCount).toBe(counts[0])
    }
  })

  it('loader returns normalized plugin functions and caches exact runtime', async () => {
    const fakeRemarkFn = vi.fn()
    const fakeRehypeFn = vi.fn()
    vi.doMock('katex/dist/katex.min.css', () => ({}))
    vi.doMock('katex/dist/contrib/copy-tex', () => ({}))
    vi.doMock('katex/dist/contrib/mhchem', () => ({}))
    vi.doMock('remark-math', () => ({
      __esModule: true,
      default: fakeRemarkFn
    }))
    vi.doMock('rehype-katex', () => ({
      __esModule: true,
      default: fakeRehypeFn
    }))

    const { loadMathRuntime } = await import('../mathLoader')
    const rt1 = await loadMathRuntime()
    const rt2 = await loadMathRuntime()
    expect(rt1.remarkMath).toBe(fakeRemarkFn)
    expect(rt1.rehypeKatex).toBe(fakeRehypeFn)
    expect(rt2).toBe(rt1)
  })

  it('handles default export shape via fallback', async () => {
    const fakeRemarkFn = vi.fn()
    const fakeRehypeFn = vi.fn()
    vi.doMock('katex/dist/katex.min.css', () => ({}))
    vi.doMock('katex/dist/contrib/copy-tex', () => ({}))
    vi.doMock('katex/dist/contrib/mhchem', () => ({}))
    // Simulate module with default property
    vi.doMock('remark-math', () => ({
      __esModule: true,
      default: fakeRemarkFn
    }))
    vi.doMock('rehype-katex', () => ({
      __esModule: true,
      default: fakeRehypeFn
    }))

    const { loadMathRuntime } = await import('../mathLoader')
    const rt = await loadMathRuntime()
    expect(rt.remarkMath).toBe(fakeRemarkFn)
    expect(rt.rehypeKatex).toBe(fakeRehypeFn)
  })
})
