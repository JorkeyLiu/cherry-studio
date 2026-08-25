/**
 * Focused pure tests for calibration matrix helpers — covers accepted audit gaps:
 * - C-02 selector grammar: short-name, full-id, ordering, duplicate rejection
 * - C-02 segment-free denominator alignment
 * - C-01 boundary/both/exact-equality behavior
 * - Pinned matrix sums/relations
 * - Multi-scale identifiers (numeric finite, unique ids)
 *
 * Measurement-only, no production source invoked. All assertions are pure.
 */

import { describe, expect, it } from 'vitest'

// C-02 helpers are E2E utils but pure — import via relative path that works in Node lane
import {
  buildC02MultiScaleMap,
  buildC02ScaleMap,
  buildC02SyntheticTopics,
  buildC02SyntheticTopicsWithPrefix,
  C02_HEAP_PROFILE_IDS,
  C02_HEAP_PROFILES,
  C02_HEAP_SHORT_NAME_MAP,
  C02_PROFILE_ID_CODE,
  detectHeapPrecisionLabel,
  getC02HeapProfileMatrix,
  RENDERER_HEAP_METHOD,
  resolveC02HeapProfile,
  resolveC02HeapProfiles
} from '../../../../../tests/e2e/utils/perfHeapCalibration'
import {
  aggregateLogicalPayload,
  B02_MAX_BYTES,
  createSyntheticB02ExactEqualityProfile,
  createSyntheticBothBoundProfile,
  createSyntheticBoundaryExactProfile,
  createSyntheticByteBoundarySmallProfile,
  createSyntheticByteFirstProfile,
  createSyntheticCountFirstProfile,
  createSyntheticOversizedSingleProfile,
  createSyntheticTopic
} from './logicalPayload'
import {
  buildMultiMatrixScaleMap,
  computeAllPinnedWorkingSetAccountings,
  computePinnedWorkingSetAccounting,
  PINNED_WORKING_SET_MATRICES
} from './pinnedWorkingSet'

// Helper to run C02 resolver with env
function withEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env.C02_HEAP_CALIBRATION
  if (value === undefined) delete process.env.C02_HEAP_CALIBRATION
  else process.env.C02_HEAP_CALIBRATION = value
  try {
    fn()
  } finally {
    if (prev === undefined) delete process.env.C02_HEAP_CALIBRATION
    else process.env.C02_HEAP_CALIBRATION = prev
  }
}

describe('C-02 selector grammar — short-name, ordering, duplicates', () => {
  it('all/matrix returns definition order', () => {
    withEnv('all', () => {
      const r = resolveC02HeapProfiles()
      expect(r.map((x) => x.id)).toEqual([
        C02_HEAP_PROFILE_IDS.small,
        C02_HEAP_PROFILE_IDS.default,
        C02_HEAP_PROFILE_IDS.large,
        C02_HEAP_PROFILE_IDS.boundary
      ])
    })
    withEnv('matrix', () => {
      const r = resolveC02HeapProfiles()
      expect(r.map((x) => x.id)).toEqual([
        C02_HEAP_PROFILE_IDS.small,
        C02_HEAP_PROFILE_IDS.default,
        C02_HEAP_PROFILE_IDS.large,
        C02_HEAP_PROFILE_IDS.boundary
      ])
    })
  })

  it('comma short-names map to full ids in caller order', () => {
    withEnv('small,large', () => {
      const r = resolveC02HeapProfiles()
      expect(r.map((x) => x.id)).toEqual([C02_HEAP_PROFILE_IDS.small, C02_HEAP_PROFILE_IDS.large])
    })
    withEnv('large,small', () => {
      const r = resolveC02HeapProfiles()
      expect(r.map((x) => x.id)).toEqual([C02_HEAP_PROFILE_IDS.large, C02_HEAP_PROFILE_IDS.small])
    })
    withEnv('boundary,default', () => {
      const r = resolveC02HeapProfiles()
      expect(r.map((x) => x.id)).toEqual([C02_HEAP_PROFILE_IDS.boundary, C02_HEAP_PROFILE_IDS.default])
    })
  })

  it('comma full ids and mixed short+full are accepted', () => {
    withEnv('c02-small-v1,c02-large-v1', () => {
      const r = resolveC02HeapProfiles()
      expect(r.map((x) => x.id)).toEqual([C02_HEAP_PROFILE_IDS.small, C02_HEAP_PROFILE_IDS.large])
    })
    withEnv('small,c02-large-v1,boundary', () => {
      const r = resolveC02HeapProfiles()
      expect(r.map((x) => x.id)).toEqual([
        C02_HEAP_PROFILE_IDS.small,
        C02_HEAP_PROFILE_IDS.large,
        C02_HEAP_PROFILE_IDS.boundary
      ])
    })
  })

  it('bare short-name resolves single profile', () => {
    withEnv('small', () => {
      const r = resolveC02HeapProfiles()
      expect(r).toHaveLength(1)
      expect(r[0].id).toBe(C02_HEAP_PROFILE_IDS.small)
    })
    withEnv('default', () => {
      const r = resolveC02HeapProfiles()
      expect(r).toHaveLength(1)
      expect(r[0].id).toBe(C02_HEAP_PROFILE_IDS.default)
    })
    withEnv('large', () => {
      const r = resolveC02HeapProfiles()
      expect(r.map((x) => x.id)).toEqual([C02_HEAP_PROFILE_IDS.large])
    })
    withEnv('boundary', () => {
      const r = resolveC02HeapProfiles()
      expect(r.map((x) => x.id)).toEqual([C02_HEAP_PROFILE_IDS.boundary])
    })
  })

  it('bare full id resolves single profile', () => {
    withEnv('c02-small-v1', () => {
      const r = resolveC02HeapProfiles()
      expect(r).toHaveLength(1)
      expect(r[0].id).toBe(C02_HEAP_PROFILE_IDS.small)
    })
    withEnv('c02-default-v1', () => {
      const r = resolveC02HeapProfiles()
      expect(r[0].id).toBe(C02_HEAP_PROFILE_IDS.default)
    })
    withEnv('c02-large-v1', () => {
      const r = resolveC02HeapProfiles()
      expect(r[0].id).toBe(C02_HEAP_PROFILE_IDS.large)
    })
    withEnv('c02-boundary-v1', () => {
      const r = resolveC02HeapProfiles()
      expect(r[0].id).toBe(C02_HEAP_PROFILE_IDS.boundary)
    })
  })

  it('short-name map covers all profiles and matches ids', () => {
    for (const [short, id] of Object.entries(C02_HEAP_SHORT_NAME_MAP)) {
      expect(C02_HEAP_PROFILES[id]).toBeDefined()
      expect(id).toBe(C02_HEAP_PROFILE_IDS[short as keyof typeof C02_HEAP_PROFILE_IDS])
    }
  })

  it('duplicate short-name or full-id throws', () => {
    withEnv('small,small', () => {
      expect(() => resolveC02HeapProfiles()).toThrow(/duplicate/)
    })
    withEnv('c02-small-v1,c02-small-v1', () => {
      expect(() => resolveC02HeapProfiles()).toThrow(/duplicate/)
    })
    withEnv('small,c02-small-v1', () => {
      expect(() => resolveC02HeapProfiles()).toThrow(/duplicate/)
    })
  })

  it('unknown id throws', () => {
    withEnv('unknown', () => {
      expect(() => resolveC02HeapProfiles()).toThrow(/unsupported/)
    })
    withEnv('small,unknown', () => {
      expect(() => resolveC02HeapProfiles()).toThrow(/unknown/)
    })
  })

  it('single-profile 1/true returns default only', () => {
    withEnv('1', () => {
      const r = resolveC02HeapProfiles()
      expect(r).toHaveLength(1)
      expect(r[0].id).toBe(C02_HEAP_PROFILE_IDS.default)
    })
    withEnv('true', () => {
      const r = resolveC02HeapProfiles()
      expect(r).toHaveLength(1)
      expect(r[0].id).toBe(C02_HEAP_PROFILE_IDS.default)
    })
  })

  it('trimming and case-insensitive', () => {
    withEnv('  Small , LARGE ', () => {
      const r = resolveC02HeapProfiles()
      expect(r.map((x) => x.id)).toEqual([C02_HEAP_PROFILE_IDS.small, C02_HEAP_PROFILE_IDS.large])
    })
  })

  it('getC02HeapProfileMatrix is deterministic and profileCount matches', () => {
    const m1 = getC02HeapProfileMatrix()
    const m2 = getC02HeapProfileMatrix()
    expect(m1.map((x) => x.id)).toEqual(m2.map((x) => x.id))
    expect(m1).toHaveLength(4)
  })

  it('pinned matrix sums are invariant per entry (caller-order preserved)', () => {
    withEnv('large,small,boundary', () => {
      const r = resolveC02HeapProfiles()
      expect(r.map((x) => x.id)).toEqual([
        C02_HEAP_PROFILE_IDS.large,
        C02_HEAP_PROFILE_IDS.small,
        C02_HEAP_PROFILE_IDS.boundary
      ])
    })
  })

  it('unset and whitespace selectors are fail-closed (empty)', () => {
    withEnv(undefined, () => {
      expect(() => resolveC02HeapProfiles()).toThrow(/empty/)
    })
    withEnv('', () => {
      expect(() => resolveC02HeapProfiles()).toThrow(/empty/)
    })
    withEnv('   ', () => {
      expect(() => resolveC02HeapProfiles()).toThrow(/empty/)
    })
    withEnv('\t\n ', () => {
      expect(() => resolveC02HeapProfiles()).toThrow(/empty/)
    })
  })

  it('leading/trailing/interior empty tokens are rejected', () => {
    withEnv(',small', () => {
      expect(() => resolveC02HeapProfiles()).toThrow(/empty.*token/i)
    })
    withEnv('small,', () => {
      expect(() => resolveC02HeapProfiles()).toThrow(/empty.*token/i)
    })
    withEnv('small,,large', () => {
      expect(() => resolveC02HeapProfiles()).toThrow(/empty.*token/i)
    })
    withEnv(',small,large', () => {
      expect(() => resolveC02HeapProfiles()).toThrow(/empty.*token/i)
    })
    withEnv('small,large,', () => {
      expect(() => resolveC02HeapProfiles()).toThrow(/empty.*token/i)
    })
    withEnv(',', () => {
      expect(() => resolveC02HeapProfiles()).toThrow(/empty.*token/i)
    })
    withEnv(',,', () => {
      expect(() => resolveC02HeapProfiles()).toThrow(/empty.*token/i)
    })
    withEnv('small, ,large', () => {
      expect(() => resolveC02HeapProfiles()).toThrow(/empty.*token/i)
    })
  })
})

describe('C-02 singular resolver — full id acceptance and matrix rejection', () => {
  it('singular resolver accepts bare full id', () => {
    withEnv('c02-small-v1', () => {
      const p = resolveC02HeapProfile()
      expect(p.syntheticTopics).toBe(C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small].syntheticTopics)
    })
    withEnv('c02-default-v1', () => {
      const p = resolveC02HeapProfile()
      expect(p).toEqual(C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.default])
    })
    withEnv('c02-large-v1', () => {
      const p = resolveC02HeapProfile()
      expect(p.syntheticTopics).toBe(3)
    })
    withEnv('c02-boundary-v1', () => {
      const p = resolveC02HeapProfile()
      expect(p.syntheticTopics).toBe(2)
    })
  })

  it('singular resolver accepts bare short-name', () => {
    withEnv('small', () => {
      const p = resolveC02HeapProfile()
      expect(p).toEqual(C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.small])
    })
    withEnv('large', () => {
      const p = resolveC02HeapProfile()
      expect(p.syntheticTopics).toBe(C02_HEAP_PROFILES[C02_HEAP_PROFILE_IDS.large].syntheticTopics)
    })
  })

  it('singular resolver rejects all/matrix', () => {
    withEnv('all', () => {
      expect(() => resolveC02HeapProfile()).toThrow(/exactly one/)
    })
    withEnv('matrix', () => {
      expect(() => resolveC02HeapProfile()).toThrow(/exactly one/)
    })
  })

  it('singular resolver rejects comma lists', () => {
    withEnv('small,large', () => {
      expect(() => resolveC02HeapProfile()).toThrow(/exactly one/)
    })
    withEnv('c02-small-v1,c02-large-v1', () => {
      expect(() => resolveC02HeapProfile()).toThrow(/exactly one/)
    })
    withEnv('small,c02-large-v1', () => {
      expect(() => resolveC02HeapProfile()).toThrow(/exactly one/)
    })
  })
})

describe('C-02 segment-free denominator alignment', () => {
  it('all C-02 profiles have segmentCount 0', () => {
    for (const profile of Object.values(C02_HEAP_PROFILES)) {
      expect(profile.segmentCountPerTopic).toBe(0)
    }
  })

  it('synthetic C-02 topics have empty segments and canonical bytes exclude segment payload', () => {
    for (const id of Object.keys(C02_HEAP_PROFILES)) {
      const profile = C02_HEAP_PROFILES[id]
      const topics = buildC02SyntheticTopics(profile)
      for (const t of topics) {
        expect(t.segments).toHaveLength(0)
      }
      const topicsPrefixed = buildC02SyntheticTopicsWithPrefix(profile, `c02-${id}-topic`)
      for (const t of topicsPrefixed) {
        expect(t.segments).toHaveLength(0)
      }
    }
  })

  it('pinned sums per matrix are exact', () => {
    const all = computeAllPinnedWorkingSetAccountings()
    for (const entry of all) {
      expect(entry.accounting.combinedCheck).toBe(true)
      expect(entry.accounting.combined.aggregateBytes).toBe(
        entry.accounting.pinned.aggregateBytes + entry.accounting.evictable.aggregateBytes
      )
    }
  })
})

describe('C-01 boundary/both/exact-equality behavior', () => {
  it('boundary exact at B-01 limit (8 topics) is none', () => {
    const topics = createSyntheticBoundaryExactProfile()
    const agg = aggregateLogicalPayload(topics)
    expect(agg.topicCount).toBe(8)
    expect(agg.isCountBound).toBe(false)
    expect(agg.isByteBound).toBe(false)
    expect(agg.binding).toBe('none')
  })

  it('both-bound (9 topics >8 and >32MiB) is both', () => {
    const topics = createSyntheticBothBoundProfile()
    const agg = aggregateLogicalPayload(topics)
    expect(agg.topicCount).toBe(9)
    expect(agg.isCountBound).toBe(true)
    expect(agg.isByteBound).toBe(true)
    expect(agg.binding).toBe('both')
  })

  it('count-first is count-first, byte-first is byte-first', () => {
    const cf = aggregateLogicalPayload(createSyntheticCountFirstProfile())
    const bf = aggregateLogicalPayload(createSyntheticByteFirstProfile())
    expect(cf.binding).toBe('count-first')
    expect(cf.isCountBound).toBe(true)
    expect(cf.isByteBound).toBe(false)
    expect(bf.binding).toBe('byte-first')
    expect(bf.isByteBound).toBe(true)
    expect(bf.isCountBound).toBe(false)
  })

  it('byte-boundary small is none', () => {
    const agg = aggregateLogicalPayload(createSyntheticByteBoundarySmallProfile())
    expect(agg.binding).toBe('none')
    expect(agg.isCountBound).toBe(false)
    expect(agg.isByteBound).toBe(false)
  })

  it('B-02 exact equality is exactly 32MiB and not bound (strict >)', () => {
    const topics = createSyntheticB02ExactEqualityProfile()
    const agg = aggregateLogicalPayload(topics)
    expect(agg.aggregateBytes).toBe(B02_MAX_BYTES)
    expect(agg.perTopic[0].byteLength).toBe(B02_MAX_BYTES)
    expect(agg.isByteBound).toBe(false)
    expect(agg.isCountBound).toBe(false)
    expect(agg.binding).toBe('none')
    expect(agg.oversizedTopicIds).toHaveLength(0)
    // One byte over should be byte-bound — same topicId, +1 blockContentSize
    const base = topics[0]
    const baseBlockSize = base.blocks[0].content as string
    const over = createSyntheticTopic({
      topicId: base.topicId,
      messageCount: 1,
      blockContentSize: baseBlockSize.length + 1,
      segmentCount: 0
    })
    const overAgg = aggregateLogicalPayload([over])
    expect(overAgg.aggregateBytes).toBe(B02_MAX_BYTES + 1)
    expect(overAgg.isByteBound).toBe(true)
    expect(overAgg.oversizedTopicIds.length).toBe(1)
  })

  it('oversized single is >32MiB and oversized', () => {
    const topics = createSyntheticOversizedSingleProfile()
    const agg = aggregateLogicalPayload(topics)
    expect(topics).toHaveLength(1)
    expect(agg.aggregateBytes).toBeGreaterThan(B02_MAX_BYTES)
    expect(agg.isByteBound).toBe(true)
    expect(agg.oversizedTopicIds).toEqual([topics[0].topicId])
    expect(agg.perTopic[0].byteLength).toBeGreaterThan(B02_MAX_BYTES)
    expect(agg.binding).toBe('byte-first')
  })
})

describe('pinned matrix sums/relations', () => {
  it('standard pinned matrix sums exactly', () => {
    const a = computePinnedWorkingSetAccounting()
    expect(a.combinedCheck).toBe(true)
    expect(a.combined.aggregateBytes).toBe(a.pinned.aggregateBytes + a.evictable.aggregateBytes)
    expect(a.enlargementRatio).toBeGreaterThan(1)
    expect(Number.isFinite(a.enlargementRatio)).toBe(true)
  })

  it('all matrices have pinned+evictable == combined and enlargement >1', () => {
    const all = computeAllPinnedWorkingSetAccountings()
    expect(all.length).toBe(PINNED_WORKING_SET_MATRICES.length)
    expect(all.length).toBeGreaterThanOrEqual(3)
    for (const e of all) {
      expect(e.accounting.combinedCheck).toBe(true)
      expect(e.accounting.enlargementRatio).toBeGreaterThan(1)
      expect(e.accounting.unlimited.aggregateBytes).toBeGreaterThan(e.accounting.pinned.aggregateBytes)
      for (const part of [e.accounting.pinned, e.accounting.evictable, e.accounting.combined, e.accounting.unlimited]) {
        expect(Number.isFinite(part.aggregateBytes)).toBe(true)
        expect(part.aggregateBytes).toBeGreaterThan(0)
        for (const p of part.perTopic) {
          expect(Number.isFinite(p.byteLength)).toBe(true)
          expect(p.byteLength).toBeGreaterThan(0)
        }
      }
    }
  })

  it('multi-matrix enlargement ratios show relation (finite, distinct)', () => {
    const all = computeAllPinnedWorkingSetAccountings()
    const ratios = all.map((e) => e.accounting.enlargementRatio)
    for (const r of ratios) expect(Number.isFinite(r)).toBe(true)
    // At least two ratios should differ (different scales produce different ratios)
    const uniq = new Set(ratios.map((r) => r.toFixed(3)))
    expect(uniq.size).toBeGreaterThan(1)
  })
})

describe('multi-scale identifiers — numeric finite and unique', () => {
  it('C-02 scale maps are numeric finite', () => {
    const matrix = getC02HeapProfileMatrix()
    const first = matrix[0]
    const scale = buildC02ScaleMap(first.profile, 'performance.memory', 'precise')
    for (const [k, v] of Object.entries(scale)) {
      expect(Number.isFinite(v), `${k} must be finite`).toBe(true)
    }
    const multi = buildC02MultiScaleMap(matrix, 'performance.memory', 'precise')
    for (const [k, v] of Object.entries(multi)) {
      expect(Number.isFinite(v), `${k} must be finite`).toBe(true)
    }
    expect(multi.profileCount).toBe(matrix.length)
    expect(multi.profileIdCode).toBe(C02_PROFILE_ID_CODE[first.id])
  })

  it('pinned scale maps are numeric finite', () => {
    const scale = buildMultiMatrixScaleMap()
    for (const [k, v] of Object.entries(scale)) {
      expect(Number.isFinite(v), `${k} must be finite`).toBe(true)
    }
    expect(scale.matrixCount).toBe(PINNED_WORKING_SET_MATRICES.length)
  })

  it('unique profile ids are unique and have numeric codes', () => {
    const ids = Object.values(C02_HEAP_PROFILE_IDS)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(Number.isFinite(C02_PROFILE_ID_CODE[id])).toBe(true)
    }
    const matrixIds = getC02HeapProfileMatrix().map((x) => x.id)
    expect(new Set(matrixIds).size).toBe(matrixIds.length)
  })

  it('multi-profile logical byte sums are deterministic', () => {
    const bytes1 = getC02HeapProfileMatrix().reduce((acc, p) => {
      const t = buildC02SyntheticTopics(p.profile)
      const agg = aggregateLogicalPayload(t)
      return acc + agg.aggregateBytes
    }, 0)
    const bytes2 = getC02HeapProfileMatrix().reduce((acc, p) => {
      const t = buildC02SyntheticTopics(p.profile)
      const agg = aggregateLogicalPayload(t)
      return acc + agg.aggregateBytes
    }, 0)
    expect(bytes1).toBe(bytes2)
    expect(Number.isFinite(bytes1)).toBe(true)
    expect(bytes1).toBeGreaterThan(0)
  })
})

describe('heap precision detection — exact flag required', () => {
  it('detects precise only with exact --enable-precise-memory-info token', () => {
    expect(detectHeapPrecisionLabel(['electron', '--enable-precise-memory-info'], RENDERER_HEAP_METHOD)).toBe('precise')
    expect(detectHeapPrecisionLabel(['--enable-precise-memory-info', '--no-sandbox'], RENDERER_HEAP_METHOD)).toBe(
      'precise'
    )
  })

  it('rejects substring and variant flag forms as bucketed', () => {
    expect(detectHeapPrecisionLabel(['electron', '--enable-precise-memory-info-foo'], RENDERER_HEAP_METHOD)).toBe(
      'bucketed'
    )
    expect(detectHeapPrecisionLabel(['electron', 'enable-precise-memory-info'], RENDERER_HEAP_METHOD)).toBe('bucketed')
    expect(detectHeapPrecisionLabel(['electron', '--enable-precise-memory-info=true'], RENDERER_HEAP_METHOD)).toBe(
      'bucketed'
    )
    expect(detectHeapPrecisionLabel(['electron', '--enable-precise-memory-info '], RENDERER_HEAP_METHOD)).toBe(
      'bucketed'
    )
    expect(detectHeapPrecisionLabel(['electron', '--foo-enable-precise-memory-info'], RENDERER_HEAP_METHOD)).toBe(
      'bucketed'
    )
    expect(detectHeapPrecisionLabel(['electron', '--ENABLE-PRECISE-MEMORY-INFO'], RENDERER_HEAP_METHOD)).toBe(
      'bucketed'
    )
    expect(detectHeapPrecisionLabel(['electron', '--no-sandbox'], RENDERER_HEAP_METHOD)).toBe('bucketed')
    expect(detectHeapPrecisionLabel([], RENDERER_HEAP_METHOD)).toBe('bucketed')
  })

  it('returns unsupported for unsupported method regardless of argv', () => {
    expect(detectHeapPrecisionLabel(['--enable-precise-memory-info'], 'unsupported')).toBe('unsupported')
    expect(detectHeapPrecisionLabel(['--enable-precise-memory-info'], 'other')).toBe('unsupported')
  })
})
