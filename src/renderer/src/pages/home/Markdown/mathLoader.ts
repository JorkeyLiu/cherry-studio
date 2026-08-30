import type rehypeKatexDefault from 'rehype-katex'
import type remarkMathDefault from 'remark-math'

export type MathRuntime = {
  remarkMath: typeof remarkMathDefault
  rehypeKatex: typeof rehypeKatexDefault
}

let cachedRuntime: MathRuntime | null = null
let pendingPromise: Promise<MathRuntime> | null = null

function resolveDefault<T>(mod: unknown): T {
  if (mod !== null && typeof mod === 'object' && 'default' in (mod as Record<string, unknown>)) {
    const maybe = mod as { default?: T }
    if (maybe.default !== undefined && maybe.default !== null) {
      return maybe.default
    }
  }
  return mod as T
}

export function loadMathRuntime(): Promise<MathRuntime> {
  if (cachedRuntime) {
    return Promise.resolve(cachedRuntime)
  }
  if (pendingPromise) {
    return pendingPromise
  }
  pendingPromise = (async (): Promise<MathRuntime> => {
    await import('katex/dist/katex.min.css')
    await import('katex/dist/contrib/copy-tex')
    await import('katex/dist/contrib/mhchem')
    const remarkMathModule = await import('remark-math')
    const rehypeKatexModule = await import('rehype-katex')
    const remarkMath = resolveDefault<typeof remarkMathDefault>(remarkMathModule as unknown)
    const rehypeKatex = resolveDefault<typeof rehypeKatexDefault>(rehypeKatexModule as unknown)
    const runtime: MathRuntime = {
      remarkMath,
      rehypeKatex
    }
    cachedRuntime = runtime
    return runtime
  })().then(
    (runtime) => {
      pendingPromise = null
      return runtime
    },
    (error) => {
      pendingPromise = null
      throw error
    }
  )
  return pendingPromise
}
