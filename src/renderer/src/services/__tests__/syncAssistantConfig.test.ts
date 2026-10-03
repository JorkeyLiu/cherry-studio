import { describe, expect, it, vi } from 'vitest'

import { applyRemoteProjectionBatch, drainAssistantConfigPending } from '../syncAssistantConfig'

describe('syncAssistantConfig renderer bridge', () => {
  it('drains durable pending until ack; failures retained for restart replay', async () => {
    const acked: string[] = []
    const failing = {
      kind: 'assistant' as const,
      id: 'a1',
      mutationId: 'm1',
      revision: 1,
      timestamp: 1,
      fields: { name: 'n1' }
    }
    const ok = {
      kind: 'assistant' as const,
      id: 'a2',
      mutationId: 'm2',
      revision: 1,
      timestamp: 1,
      fields: { name: 'n2' }
    }
    const result = await drainAssistantConfigPending({
      pending: [failing, ok],
      commit: async (d) => {
        if (d.mutationId === 'm1') throw new Error('offline')
        return { key: d.id }
      },
      onAcked: (d) => {
        acked.push(d.mutationId)
      }
    })
    expect(result).toEqual({ acked: 1, retained: 1 })
    expect(acked).toEqual(['m2'])
  })

  it('remote apply uses fromSync meta (no echo) and skips invalid entries', async () => {
    const applied: unknown[] = []
    const acked: Array<[string, number]> = []
    const result = await applyRemoteProjectionBatch({
      batch: [
        {
          key: 'assistant_config:assistant:a1',
          payload: { schemaVersion: 1, kind: 'assistant', id: 'a1', name: 'remote' },
          projectionRevision: 4
        },
        {
          key: 'assistant_config:assistant:bad',
          payload: { schemaVersion: 1, kind: 'assistant', id: 'bad', topics: [] } as never,
          projectionRevision: 4
        }
      ],
      applyOne: (payload, meta) => {
        applied.push({ payload, meta })
      },
      ackOne: async (key, rev) => {
        acked.push([key, rev])
      }
    })
    expect(result).toEqual({ applied: 1, skipped: 1 })
    expect(applied[0]).toMatchObject({ meta: { fromSync: true, projectionRevision: 4 } })
    expect(acked).toEqual([['assistant_config:assistant:a1', 4]])
    expect(vi.fn().mock.calls.length).toBe(0)
  })

  it('APPLY -> FLUSH resolved -> ACK ordering per entry', async () => {
    const order: string[] = []
    const batch = [
      {
        key: 'assistant_config:assistant:a1',
        payload: { schemaVersion: 1, kind: 'assistant' as const, id: 'a1', name: 'r1' } as any,
        projectionRevision: 10
      },
      {
        key: 'assistant_config:assistant:a2',
        payload: { schemaVersion: 1, kind: 'assistant' as const, id: 'a2', name: 'r2' } as any,
        projectionRevision: 11
      }
    ]
    await applyRemoteProjectionBatch({
      batch,
      applyOne: () => order.push('apply'),
      flush: async () => {
        order.push('flush-start')
        await Promise.resolve()
        order.push('flush-end')
      },
      ackOne: async () => {
        order.push('ack')
      }
    })
    expect(order).toEqual(['apply', 'flush-start', 'flush-end', 'ack', 'apply', 'flush-start', 'flush-end', 'ack'])
  })

  it('flush reject retains projection (no ack) and replay recovers', async () => {
    const acked: string[] = []
    let flushCount = 0
    const batch = [
      {
        key: 'assistant_config:assistant:a1',
        payload: { schemaVersion: 1, kind: 'assistant' as const, id: 'a1', name: 'r1' } as any,
        projectionRevision: 20
      }
    ]
    const deps = {
      batch,
      applyOne: vi.fn(),
      flush: vi.fn(async () => {
        flushCount++
        if (flushCount === 1) throw new Error('flush fail')
      }),
      ackOne: vi.fn(async (k: string) => {
        acked.push(k)
      })
    }
    const first = await applyRemoteProjectionBatch(deps)
    expect(first).toEqual({ applied: 0, skipped: 1 })
    expect(deps.ackOne).not.toHaveBeenCalled()
    // replay with flush success
    const second = await applyRemoteProjectionBatch(deps)
    expect(second).toEqual({ applied: 1, skipped: 0 })
    expect(acked).toEqual(['assistant_config:assistant:a1'])
  })

  it('duplicate batch ack is idempotent and fromSync prevents echo', async () => {
    const applied: Array<{ id: string; meta: unknown }> = []
    const acked: string[] = []
    let echoCount = 0
    const entry = {
      key: 'assistant_config:assistant:a1',
      payload: { schemaVersion: 1, kind: 'assistant' as const, id: 'a1', name: 'dup' } as any,
      projectionRevision: 30
    }
    const applyOne = (payload: any, meta: any) => {
      applied.push({ id: payload.id, meta })
      // simulate no echo: fromSync true never enqueues
      if (!meta.fromSync) echoCount++
    }
    await applyRemoteProjectionBatch({
      batch: [entry],
      applyOne,
      flush: async () => {},
      ackOne: async (k) => acked.push(k)
    })
    await applyRemoteProjectionBatch({
      batch: [entry],
      applyOne,
      flush: async () => {},
      ackOne: async (k) => acked.push(k)
    })
    expect(applied.length).toBe(2)
    expect(applied.every((a) => (a.meta as any).fromSync === true)).toBe(true)
    expect(echoCount).toBe(0)
    expect(acked).toEqual(['assistant_config:assistant:a1', 'assistant_config:assistant:a1'])
  })
})
