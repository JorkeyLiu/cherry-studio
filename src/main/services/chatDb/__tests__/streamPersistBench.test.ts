import { describe, expect, it } from 'vitest'

import {
  assertStreamPersistSampleCounts,
  buildStreamPersistGates,
  buildStreamPersistMetrics,
  deriveStreamPersistDifferentialSamples,
  resolveStreamPersistGate,
  STREAM_PERSIST_COMPLETION_STATUS,
  STREAM_PERSIST_MEASURE_ROUNDS,
  STREAM_PERSIST_PROFILES,
  STREAM_PERSIST_STREAMING_STATUS,
  STREAM_PERSIST_WARMUP_ROUNDS,
  streamPersistContent,
  streamPersistExpectedRowidAdvance,
  type StreamPersistLaneSamples,
  type StreamPersistProfileKey,
  streamPersistShouldHeatBeforeTimed,
  streamPersistStats,
  streamPersistStatus
} from './streamPersistBench'

describe('resolveStreamPersistGate', () => {
  it('disabled for unset/empty, enabled for 1/true, throws otherwise', () => {
    expect(resolveStreamPersistGate(undefined)).toBe(false)
    expect(resolveStreamPersistGate('')).toBe(false)
    expect(resolveStreamPersistGate('1')).toBe(true)
    expect(resolveStreamPersistGate('true')).toBe(true)
    expect(resolveStreamPersistGate('TRUE')).toBe(true)
    expect(() => resolveStreamPersistGate('2')).toThrow(/STREAM_PERSIST_BENCH/)
    expect(() => resolveStreamPersistGate('on')).toThrow(/STREAM_PERSIST_BENCH/)
  })
})

describe('streamPersistContent', () => {
  it('growth content grows monotonically with the round index', () => {
    const c1 = streamPersistContent('growth', 1)
    const c2 = streamPersistContent('growth', 2)
    const cMax = streamPersistContent('growth', STREAM_PERSIST_MEASURE_ROUNDS)
    expect(c1.length).toBeLessThan(c2.length)
    expect(c2.length).toBeLessThan(cMax.length)
  })

  it('nochange and completion content is identical across rounds', () => {
    expect(streamPersistContent('nochange', 1)).toBe(streamPersistContent('nochange', 5))
    expect(streamPersistContent('completion', 1)).toBe(streamPersistContent('completion', 5))
    expect(streamPersistContent('nochange', 1)).toBe(streamPersistContent('completion', 1))
  })
})

describe('streamPersistStatus', () => {
  it('growth and nochange always streaming regardless of round', () => {
    for (const r of [
      1,
      STREAM_PERSIST_WARMUP_ROUNDS,
      STREAM_PERSIST_WARMUP_ROUNDS + 1,
      STREAM_PERSIST_WARMUP_ROUNDS + STREAM_PERSIST_MEASURE_ROUNDS
    ]) {
      expect(streamPersistStatus('growth', r)).toBe(STREAM_PERSIST_STREAMING_STATUS)
      expect(streamPersistStatus('nochange', r)).toBe(STREAM_PERSIST_STREAMING_STATUS)
    }
  })

  it('completion is streaming during warmup and success during measured', () => {
    for (let r = 1; r <= STREAM_PERSIST_WARMUP_ROUNDS; r++) {
      expect(streamPersistStatus('completion', r)).toBe(STREAM_PERSIST_STREAMING_STATUS)
    }
    for (
      let r = STREAM_PERSIST_WARMUP_ROUNDS + 1;
      r <= STREAM_PERSIST_WARMUP_ROUNDS + STREAM_PERSIST_MEASURE_ROUNDS;
      r++
    ) {
      expect(streamPersistStatus('completion', r)).toBe(STREAM_PERSIST_COMPLETION_STATUS)
    }
    expect(streamPersistStatus('completion', STREAM_PERSIST_WARMUP_ROUNDS)).toBe(STREAM_PERSIST_STREAMING_STATUS)
    expect(streamPersistStatus('completion', STREAM_PERSIST_WARMUP_ROUNDS + 1)).toBe(STREAM_PERSIST_COMPLETION_STATUS)
  })
})

describe('deriveStreamPersistDifferentialSamples', () => {
  it('computes per-round triggerOn − baseOnly and fails on length mismatch', () => {
    expect(deriveStreamPersistDifferentialSamples({ triggerOn: [2, 3, 4], baseOnly: [1, 1, 1] })).toEqual([1, 2, 3])
    expect(() => deriveStreamPersistDifferentialSamples({ triggerOn: [1, 2], baseOnly: [1] })).toThrow(/same length/)
  })
})

describe('streamPersistStats', () => {
  it('computes nearest-rank p50/p95/mean/min/max and throws on empty', () => {
    const stats = streamPersistStats([1, 2, 3, 4, 5, 6, 7, 8])
    expect(stats.min).toBe(1)
    expect(stats.max).toBe(8)
    expect(stats.mean).toBe(4.5)
    // Nearest-rank percentile: index = ceil(p/100 * n) − 1 (n=8 → p50 index 3 = 4).
    expect(stats.p50).toBe(4)
    expect(stats.p95).toBe(8)
    expect(() => streamPersistStats([])).toThrow(/empty/)
  })
})

describe('buildStreamPersistMetrics + assertStreamPersistSampleCounts', () => {
  function validSamples(count: number): Map<StreamPersistProfileKey, StreamPersistLaneSamples> {
    const map = new Map<StreamPersistProfileKey, StreamPersistLaneSamples>()
    for (const profile of STREAM_PERSIST_PROFILES) {
      map.set(profile, {
        triggerOn: Array.from({ length: count }, () => 1),
        baseOnly: Array.from({ length: count }, () => 1)
      })
    }
    return map
  }

  it('builds a metric row for every profile/lane/stat and differential', () => {
    const metrics = buildStreamPersistMetrics(validSamples(3))
    expect(metrics.length).toBeGreaterThan(0)
    const ids = new Set(metrics.map((m) => m.id))
    expect(ids.size).toBe(metrics.length)
    expect(metrics.every((m) => Number.isFinite(m.value))).toBe(true)
  })

  it('fails fast on a missing profile sample set', () => {
    const map = validSamples(3)
    map.delete('growth')
    expect(() => buildStreamPersistMetrics(map)).toThrow(/no samples recorded for profile 'growth'/)
  })

  it('sample-count guard passes for exact counts and throws on mismatch', () => {
    const ok = assertStreamPersistSampleCounts(
      validSamples(STREAM_PERSIST_MEASURE_ROUNDS),
      STREAM_PERSIST_MEASURE_ROUNDS
    )
    expect(ok.ok).toBe(true)
    expect(ok.verifiedProfiles).toHaveLength(STREAM_PERSIST_PROFILES.length)
    expect(() => assertStreamPersistSampleCounts(validSamples(3), STREAM_PERSIST_MEASURE_ROUNDS)).toThrow(
      /has 3 samples, expected exactly/
    )
  })
})

describe('buildStreamPersistGates', () => {
  it('emits corrected projection ops and completion flip gates with expected wording', () => {
    const gates = buildStreamPersistGates(
      {
        seedParity: true,
        postBaseParity: true,
        projectionEquivalence: true,
        projectionOps: true,
        completionFlip: true,
        samplesComplete: true,
        abi137: true,
        schemaV1: true
      },
      {
        seedParity: 'seed ok',
        postBaseParity: 'post ok',
        projectionEquivalence: 'projection ok',
        projectionOps: 'ops ok',
        completionFlip: 'flip ok',
        samplesComplete: 'samples ok',
        abi137: 'abi ok'
      }
    )
    const ids = gates.map((g) => g.id)
    expect(ids).toContain('parity.completionFlip')
    expect(ids).toContain('counts.projectionOps')
    const opsGate = gates.find((g) => g.id === 'counts.projectionOps')!
    expect(opsGate.name).toContain('normalized rowid advance')
    expect(opsGate.name).toContain('1:1 projection')
    expect(opsGate.name).not.toContain('strictly more')
    const flipGate = gates.find((g) => g.id === 'parity.completionFlip')!
    expect(flipGate.name).toContain('completion')
    expect(gates).toHaveLength(8)
  })
})

describe('streamPersistShouldHeatBeforeTimed — measurement-sequence seam (locks first timed transition)', () => {
  it('heat true for all warmup rounds and every measured round except the first completion measured round', () => {
    for (const profile of STREAM_PERSIST_PROFILES) {
      for (let round = 1; round <= STREAM_PERSIST_WARMUP_ROUNDS + STREAM_PERSIST_MEASURE_ROUNDS; round++) {
        const shouldHeat = streamPersistShouldHeatBeforeTimed(profile, round)
        if (profile === 'completion' && round === STREAM_PERSIST_WARMUP_ROUNDS + 1) {
          expect(shouldHeat).toBe(false)
        } else {
          expect(shouldHeat).toBe(true)
        }
      }
    }
  })

  it('first measured completion operation is the timed streaming -> success transition with no preceding success heat write in that round', () => {
    const firstMeasuredRound = STREAM_PERSIST_WARMUP_ROUNDS + 1
    // status flips streaming (warmup) -> success (measured) at the boundary
    expect(streamPersistStatus('completion', STREAM_PERSIST_WARMUP_ROUNDS)).toBe(STREAM_PERSIST_STREAMING_STATUS)
    expect(streamPersistStatus('completion', firstMeasuredRound)).toBe(STREAM_PERSIST_COMPLETION_STATUS)
    // heat is absent for that transition, so the timed write itself performs it
    expect(streamPersistShouldHeatBeforeTimed('completion', firstMeasuredRound)).toBe(false)
    // content is identical across the flip (completion is fixed content), only status differs — proving trigger fires on the timed transition
    expect(streamPersistContent('completion', STREAM_PERSIST_WARMUP_ROUNDS)).toBe(
      streamPersistContent('completion', firstMeasuredRound)
    )
  })

  it('locks deterministic lockstep ordering — per measured round heat (if any) then triggerOn timed then baseOnly timed with identical content/status', () => {
    // Simulate the exact interleaving the harness must follow and assert ordering + argument equality.
    type Op = {
      kind: 'heatOn' | 'heatOff' | 'timedOn' | 'timedOff'
      profile: StreamPersistProfileKey
      round: number
      content: string
      status: string
    }
    const ops: Op[] = []
    for (const profile of STREAM_PERSIST_PROFILES) {
      for (let round = 1; round <= STREAM_PERSIST_WARMUP_ROUNDS + STREAM_PERSIST_MEASURE_ROUNDS; round++) {
        const shouldHeat = streamPersistShouldHeatBeforeTimed(profile, round)
        const content = streamPersistContent(profile, Math.min(round, STREAM_PERSIST_MEASURE_ROUNDS))
        const status = streamPersistStatus(profile, round)
        if (shouldHeat) {
          ops.push({ kind: 'heatOn', profile, round, content, status })
          ops.push({ kind: 'heatOff', profile, round, content, status })
        }
        if (round > STREAM_PERSIST_WARMUP_ROUNDS) {
          ops.push({ kind: 'timedOn', profile, round, content, status })
          ops.push({ kind: 'timedOff', profile, round, content, status })
        }
      }
    }
    // First measured completion round must contain timedOn/timedOff and no heat before it in that round.
    const idxFirstCompletionTimed = ops.findIndex(
      (o) => o.profile === 'completion' && o.round === STREAM_PERSIST_WARMUP_ROUNDS + 1 && o.kind === 'timedOn'
    )
    expect(idxFirstCompletionTimed).toBeGreaterThan(-1)
    // Within that round, heat must be absent — the preceding ops for that round are not heat.
    const roundSlice = ops.filter((o) => o.profile === 'completion' && o.round === STREAM_PERSIST_WARMUP_ROUNDS + 1)
    expect(roundSlice.map((o) => o.kind)).toEqual(['timedOn', 'timedOff'])
    // Every measured round must follow heat (if present) then timedOn then timedOff, never interleaved across profiles/rounds.
    for (const profile of STREAM_PERSIST_PROFILES) {
      for (
        let round = STREAM_PERSIST_WARMUP_ROUNDS + 1;
        round <= STREAM_PERSIST_WARMUP_ROUNDS + STREAM_PERSIST_MEASURE_ROUNDS;
        round++
      ) {
        const slice = ops.filter((o) => o.profile === profile && o.round === round)
        if (profile === 'completion' && round === STREAM_PERSIST_WARMUP_ROUNDS + 1) {
          expect(slice.map((o) => o.kind)).toEqual(['timedOn', 'timedOff'])
        } else {
          expect(slice.map((o) => o.kind)).toEqual(['heatOn', 'heatOff', 'timedOn', 'timedOff'])
        }
        // Argument equality: heat and timed ops in the same round share identical derived content/status,
        // and triggerOn timed vs baseOnly timed receive exactly the same arguments (lockstep).
        const expectedContent = streamPersistContent(profile, Math.min(round, STREAM_PERSIST_MEASURE_ROUNDS))
        const expectedStatus = streamPersistStatus(profile, round)
        for (const op of slice) {
          expect(op.content).toBe(expectedContent)
          expect(op.status).toBe(expectedStatus)
        }
        const timedOn = slice.find((o) => o.kind === 'timedOn')!
        const timedOff = slice.find((o) => o.kind === 'timedOff')!
        expect(timedOn.content).toBe(timedOff.content)
        expect(timedOn.status).toBe(timedOff.status)
        if (slice.some((o) => o.kind === 'heatOn')) {
          const heatOn = slice.find((o) => o.kind === 'heatOn')!
          const heatOff = slice.find((o) => o.kind === 'heatOff')!
          expect(heatOn.content).toBe(heatOff.content)
          expect(heatOn.status).toBe(heatOff.status)
          // Heat content/status equals timed content/status within the same round
          expect(heatOn.content).toBe(timedOn.content)
          expect(heatOn.status).toBe(timedOn.status)
        }
      }
    }
    // Spot-check: first timed completion transition carries the status flip with unchanged content (status-only transition proven)
    const firstCompletionTimedOn = ops.find(
      (o) => o.profile === 'completion' && o.round === STREAM_PERSIST_WARMUP_ROUNDS + 1 && o.kind === 'timedOn'
    )!
    expect(firstCompletionTimedOn.status).toBe(STREAM_PERSIST_COMPLETION_STATUS)
    expect(firstCompletionTimedOn.content).toBe(streamPersistContent('completion', STREAM_PERSIST_MEASURE_ROUNDS))
  })

  it('recalculates expected rowid advance from deterministic sequence (269) and gates exact update-count invariant', () => {
    const expected = streamPersistExpectedRowidAdvance()
    // Manual recomputation from the seam — must equal helper and not the old fixed product 270.
    let manual = 0
    for (const profile of STREAM_PERSIST_PROFILES) {
      for (let round = 1; round <= STREAM_PERSIST_WARMUP_ROUNDS + STREAM_PERSIST_MEASURE_ROUNDS; round++) {
        if (streamPersistShouldHeatBeforeTimed(profile, round)) manual += 1
        if (round > STREAM_PERSIST_WARMUP_ROUNDS) manual += 1
      }
    }
    expect(expected).toBe(manual)
    expect(expected).toBe(269)
    expect(expected).not.toBe(
      STREAM_PERSIST_PROFILES.length * (STREAM_PERSIST_WARMUP_ROUNDS + 2 * STREAM_PERSIST_MEASURE_ROUNDS)
    )
    // Exact update-count invariant: heat 149 + timed 120 = rowid advance 269
    const heatCount = STREAM_PERSIST_PROFILES.reduce((sum, p) => {
      let c = 0
      for (let r = 1; r <= STREAM_PERSIST_WARMUP_ROUNDS + STREAM_PERSIST_MEASURE_ROUNDS; r++)
        if (streamPersistShouldHeatBeforeTimed(p, r)) c++
      return sum + c
    }, 0)
    const timedCount = STREAM_PERSIST_PROFILES.length * STREAM_PERSIST_MEASURE_ROUNDS
    expect(heatCount).toBe(149)
    expect(timedCount).toBe(120)
    expect(expected).toBe(heatCount + timedCount)
  })
})
