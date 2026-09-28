/**
 * Renderer save-data handler (main window only).
 *
 * Covers: success ack, flush-failure ack, duplicate requestId dedup,
 * legacy fire-and-forget flush, malformed payload drop, ack-send failure.
 */
import { describe, expect, it, vi } from 'vitest'

import { createSaveDataHandler } from '../saveData'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
  }
}))

function makeDeps(overrides: Partial<{ flush: () => Promise<void>; ack: (ack: any) => Promise<unknown> }> = {}) {
  const flush = overrides.flush ?? vi.fn().mockResolvedValue(undefined)
  const ack = overrides.ack ?? vi.fn().mockResolvedValue(undefined)
  return { flush: flush as () => Promise<void>, ack: ack as (ack: any) => Promise<unknown> }
}

describe('createSaveDataHandler', () => {
  it('flushes and acks success', async () => {
    const deps = makeDeps()
    const handle = createSaveDataHandler(deps)
    await handle({ requestId: 'r1' })
    expect(deps.flush).toHaveBeenCalledTimes(1)
    expect(deps.ack).toHaveBeenCalledTimes(1)
    expect(deps.ack).toHaveBeenCalledWith({ requestId: 'r1', ok: true, code: 'flushed' })
  })

  it('acks failure when the flush throws', async () => {
    const deps = makeDeps({ flush: vi.fn().mockRejectedValue(new Error('leveldb busy')) })
    const handle = createSaveDataHandler(deps)
    await handle({ requestId: 'r2' })
    expect(deps.flush).toHaveBeenCalledTimes(1)
    expect(deps.ack).toHaveBeenCalledTimes(1)
    expect(deps.ack).toHaveBeenCalledWith({ requestId: 'r2', ok: false, code: 'flush-failed' })
  })

  it('dedupes duplicate delivery of the same requestId', async () => {
    const deps = makeDeps()
    const handle = createSaveDataHandler(deps)
    await handle({ requestId: 'r3' })
    await handle({ requestId: 'r3' })
    expect(deps.flush).toHaveBeenCalledTimes(1)
    expect(deps.ack).toHaveBeenCalledTimes(1)
  })

  it('handles distinct requestIds independently', async () => {
    const deps = makeDeps()
    const handle = createSaveDataHandler(deps)
    await handle({ requestId: 'r4' })
    await handle({ requestId: 'r5' })
    expect(deps.flush).toHaveBeenCalledTimes(2)
    expect(deps.ack).toHaveBeenCalledTimes(2)
  })

  it('flushes legacy undefined signals best-effort with no ack', async () => {
    const deps = makeDeps()
    const handle = createSaveDataHandler(deps)
    await handle(undefined)
    expect(deps.flush).toHaveBeenCalledTimes(1)
    expect(deps.ack).not.toHaveBeenCalled()
  })

  it('swallows legacy flush failures without acking', async () => {
    const deps = makeDeps({ flush: vi.fn().mockRejectedValue(new Error('gone')) })
    const handle = createSaveDataHandler(deps)
    await expect(handle(undefined)).resolves.toBeUndefined()
    expect(deps.ack).not.toHaveBeenCalled()
  })

  it('drops malformed payloads without flush or ack', async () => {
    const deps = makeDeps()
    const handle = createSaveDataHandler(deps)
    await handle(null)
    await handle({ requestId: '' })
    await handle({ requestId: 'r6', extra: true })
    expect(deps.flush).not.toHaveBeenCalled()
    expect(deps.ack).not.toHaveBeenCalled()
  })

  it('does not throw when the ack send itself fails', async () => {
    const deps = makeDeps({ ack: vi.fn().mockRejectedValue(new Error('renderer gone')) })
    const handle = createSaveDataHandler(deps)
    await expect(handle({ requestId: 'r7' })).resolves.toBeUndefined()
    expect(deps.flush).toHaveBeenCalledTimes(1)
  })
})
