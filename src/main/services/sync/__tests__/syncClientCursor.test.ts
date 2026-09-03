/**
 * SyncClient strict cursor boundary (LOCK-RT-002): the client validates its
 * own request cursor and every response seq/cursor as canonical non-negative
 * safe integers before any URL framing or application. Unsafe or malformed
 * values fail closed here, never stringified or skipped.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { syncClient } from '../SyncClient'

const ENDPOINT = 'http://127.0.0.1:9'

function validOp(seq: number, suffix: string): Record<string, unknown> {
  return {
    seq,
    id: `op-cursor-${suffix}`,
    entityType: 'topic',
    op: 'upsert',
    entityId: `t-cursor-${suffix}`,
    timestamp: 1,
    deviceId: 'remote',
    payload: { id: `t-cursor-${suffix}`, name: 'T' }
  }
}

function stubFetch(body: unknown): void {
  ;(globalThis as unknown as { fetch: unknown }).fetch = async () =>
    ({ ok: true, json: async () => body }) as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SyncClient request cursor validation', () => {
  it.each([[-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [Number.MAX_SAFE_INTEGER + 1]])(
    'pull rejects unsafe request cursor %s before transport',
    async (cursor) => {
      const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ operations: [], cursor: 0 }) }) as never)
      vi.stubGlobal('fetch', fetchSpy)
      await expect(syncClient.pull(ENDPOINT, undefined, cursor, 'd1')).rejects.toThrow(
        /cursor must be non-negative safe integer/
      )
      expect(fetchSpy).not.toHaveBeenCalled()
    }
  )

  it('pull accepts zero and safe-integer request cursors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('cursor=0')
        return { ok: true, json: async () => ({ operations: [], cursor: 0 }) } as never
      })
    )
    const res = await syncClient.pull(ENDPOINT, undefined, 0, 'd1')
    expect(res.cursor).toBe(0)
  })
})

describe('SyncClient response seq/cursor validation', () => {
  it.each([[1.5], [-1], [Number.MAX_SAFE_INTEGER + 1]])('pull rejects unsafe response cursor %s', async (cursor) => {
    stubFetch({ operations: [], cursor })
    await expect(syncClient.pull(ENDPOINT, undefined, cursor, 'd1')).rejects.toThrow(
      /cursor must be non-negative safe integer/
    )
  })

  it('pull rejects string response cursor without reinterpretation', async () => {
    stubFetch({ operations: [], cursor: '1' })
    await expect(syncClient.pull(ENDPOINT, undefined, 1, 'd1')).rejects.toThrow(
      /cursor must be non-negative safe integer/
    )
  })

  it.each([[0], [-2], [1.5], [Number.MAX_SAFE_INTEGER + 1]])('pull rejects unsafe response seq %s', async (seq) => {
    stubFetch({ operations: [validOp(seq, `unsafe-${String(seq)}`)], cursor: 1 })
    await expect(syncClient.pull(ENDPOINT, undefined, 0, 'd1')).rejects.toThrow(/invalid seq|non-contiguous/)
  })

  it('pull rejects string seq without reinterpretation', async () => {
    stubFetch({ operations: [{ ...validOp(1, 'str'), seq: '1' }], cursor: 1 })
    await expect(syncClient.pull(ENDPOINT, undefined, 0, 'd1')).rejects.toThrow(/invalid seq|non-contiguous/)
  })

  it('push rejects unsafe response cursor', async () => {
    for (const cursor of [1.5, -1, Number.MAX_SAFE_INTEGER + 1, '1']) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: async () => ({ cursor, acceptedIds: ['a'] }) }) as never)
      )
      await expect(syncClient.push(ENDPOINT, undefined, { deviceId: 'd1', operations: [] })).rejects.toThrow(
        /cursor must be non-negative safe integer/
      )
    }
  })

  it('contiguous safe-integer frame still passes', async () => {
    stubFetch({ operations: [validOp(1, 'ok1'), validOp(2, 'ok2')], cursor: 2 })
    const res = await syncClient.pull(ENDPOINT, undefined, 0, 'd1')
    expect(res.cursor).toBe(2)
    expect(res.operations).toHaveLength(2)
  })
})
