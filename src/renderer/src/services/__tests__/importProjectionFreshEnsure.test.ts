/**
 * Boot sequencing for the fresh-chat bootstrap finalizer.
 *
 * Contract: the finalizer sees BOTH projection outcomes before readiness —
 * applied-true clears without ensuring; verified-no-pending ensures when
 * pending; failure settles failed with the marker retained; retry is
 * idempotent (Main-side ensure is create-only).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getImportProjectionReadinessState,
  isImportProjectionReady,
  resetImportProjectionReadiness,
  retryImportProjectionReadiness,
  runImportProjectionBoot,
  runReduxStoreBoot
} from '../importProjectionReadiness'

describe('fresh-chat bootstrap finalizer sequencing', () => {
  beforeEach(() => {
    resetImportProjectionReadiness()
  })

  it('fresh/no-pending finalizes (apply -> finalize -> ready)', async () => {
    const order: string[] = []
    const result = await runImportProjectionBoot({
      apply: async () => {
        order.push('apply')
        return false
      },
      finalizeFreshBootstrap: async (applied) => {
        order.push(`finalize:${applied}`)
      }
    })
    expect(result).toBe('ready')
    expect(order).toEqual(['apply', 'finalize:false'])
    expect(isImportProjectionReady()).toBe(true)
  })

  it('applied import still runs the finalizer (marker cleared without ensure)', async () => {
    const order: string[] = []
    const result = await runImportProjectionBoot({
      apply: async () => {
        order.push('apply')
        return true
      },
      finalizeFreshBootstrap: async (applied) => {
        order.push(`finalize:${applied}`)
      }
    })
    expect(result).toBe('ready')
    expect(order).toEqual(['apply', 'finalize:true'])
    expect(isImportProjectionReady()).toBe(true)
  })

  it('no finalizer keeps the plain apply -> ready contract', async () => {
    const result = await runImportProjectionBoot({ apply: async () => false })
    expect(result).toBe('ready')
    expect(getImportProjectionReadinessState()).toBe('ready')
  })

  it('finalize failure yields failed readiness (tree stays gated)', async () => {
    const result = await runImportProjectionBoot({
      apply: async () => false,
      finalizeFreshBootstrap: async () => {
        throw new Error('ensureTopic IPC failed')
      }
    })
    expect(result).toBe('failed')
    expect(isImportProjectionReady()).toBe(false)
    expect(getImportProjectionReadinessState()).toBe('failed')
  })

  it('retry after finalize failure can succeed (idempotent rerun)', async () => {
    let calls = 0
    const flakyFinalize = async () => {
      calls++
      if (calls === 1) throw new Error('ensureTopic IPC failed')
      // Second attempt: create-only rerun, safe after a partial ensure.
    }
    await runImportProjectionBoot({ apply: async () => false, finalizeFreshBootstrap: flakyFinalize })
    expect(getImportProjectionReadinessState()).toBe('failed')
    const retried = await retryImportProjectionReadiness()
    expect(retried).toBe('ready')
    expect(calls).toBe(2)
    expect(isImportProjectionReady()).toBe(true)
  })

  it('runReduxStoreBoot threads the finalizer dep (notify independent)', async () => {
    const notifyMain = vi.fn()
    const finalize = vi.fn()
    const result = await runReduxStoreBoot({ notifyMain, apply: async () => false, finalizeFreshBootstrap: finalize })
    expect(result).toBe('ready')
    expect(notifyMain).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledExactlyOnceWith(false)
  })
})
