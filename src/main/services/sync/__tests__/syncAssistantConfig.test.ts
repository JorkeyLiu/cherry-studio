import { describe, expect, it } from 'vitest'

import {
  ackProjection,
  commitLocalDelta,
  createMemoryAssistantConfigDb,
  createProjectionBatch,
  receiveRemoteMergedConfig,
  snapshotForBaseline
} from '../syncAssistantConfig'

const delta = (mutationId: string, fields = { name: 'n' }, revision = 1) => ({
  kind: 'assistant' as const,
  id: 'a1',
  mutationId,
  revision,
  timestamp: 1,
  fields: { ...fields, schemaVersion: undefined } as never
})

describe('syncAssistantConfig mirror', () => {
  it('commits local delta atomically; enqueue failure rolls back', () => {
    const db = createMemoryAssistantConfigDb()
    const r = commitLocalDelta(
      db,
      { kind: 'assistant', id: 'a1', mutationId: 'm1', revision: 1, timestamp: 1, fields: { name: 'n1' } },
      {}
    )
    expect(r.acked).toBe(true)
    expect(() => {
      return commitLocalDelta(
        db,
        { kind: 'assistant', id: 'a1', mutationId: 'm2', revision: 2, timestamp: 2, fields: { name: 'n2' } },
        {
          enqueue: () => {
            throw new Error('outbox down')
          }
        }
      )
    }).toThrow('outbox down')
    // Rolled back: still version 1 with first payload.
    expect(db.getRow('assistant_config:assistant:a1')!.version).toBe(1)
  })

  it('barrier gate throws before tx; same mutationId repeats no extra op', () => {
    const db = createMemoryAssistantConfigDb()
    expect(() =>
      commitLocalDelta(
        db,
        { kind: 'assistant', id: 'a1', mutationId: 'm1', revision: 1, timestamp: 1, fields: { name: 'n' } },
        {
          publishGate: () => {
            throw new Error('barrier closed')
          }
        }
      )
    ).toThrow('barrier closed')
    expect(db.getRow('assistant_config:assistant:a1')).toBeNull()
    const d = {
      kind: 'assistant' as const,
      id: 'a1',
      mutationId: 'm1',
      revision: 1,
      timestamp: 1,
      fields: { name: 'n' }
    }
    const first = commitLocalDelta(db, d, {})
    const repeat = commitLocalDelta(db, d, {
      enqueue: () => {
        throw new Error('must not enqueue duplicate')
      }
    })
    expect(repeat.duplicate).toBe(true)
    expect(repeat.version).toBe(first.version)
  })

  it('remote receive bypasses local gate; stale revisions never rewind', () => {
    const db = createMemoryAssistantConfigDb()
    const gate = () => {
      throw new Error('local gate closed')
    }
    // Local commit blocked by gate.
    expect(() => commitLocalDelta(db, delta('m1'), { publishGate: gate })).toThrow()
    // Remote path ignores the local gate by design.
    const ok = receiveRemoteMergedConfig(db, { schemaVersion: 1, kind: 'assistant', id: 'a1', name: 'remote' }, 5)
    expect(ok.projectionRevision).toBe(5)
    const stale = receiveRemoteMergedConfig(db, { schemaVersion: 1, kind: 'assistant', id: 'a1', name: 'stale' }, 3)
    expect(stale.projectionRevision).toBe(5)
    expect(createProjectionBatch(db)[0].payload.name).toBe('remote')
  })

  it('ack is strict-version; snapshot is complete and explicit', () => {
    const db = createMemoryAssistantConfigDb()
    receiveRemoteMergedConfig(db, { schemaVersion: 1, kind: 'assistant', id: 'a1', name: 'r' }, 7)
    expect(ackProjection(db, 'assistant_config:assistant:a1', 6).cleared).toBe(false)
    expect(ackProjection(db, 'assistant_config:assistant:a1', 7).cleared).toBe(true)
    expect(ackProjection(db, 'assistant_config:assistant:a1', 7).cleared).toBe(true)
    // Deletion is explicit tombstone, never snapshot absence.
    receiveRemoteMergedConfig(db, { schemaVersion: 1, kind: 'assistant', id: 'gone', deleted: true }, 8)
    const snap = snapshotForBaseline(db)
    expect(snap.find((p) => p.id === 'gone')!.deleted).toBe(true)
    expect(snap.length).toBe(2)
  })
})
