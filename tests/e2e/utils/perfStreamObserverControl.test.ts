/**
 * Pure unit tests for the PERF-STREAM-ATTR-003 observer control helpers
 * (tests/e2e/utils/perfStreamObserverControl.ts). These run in the Node
 * `e2e-utils` vitest lane and lock the observer mode resolution, benchmark id
 * derivation, and scale map construction independently of any
 * Electron/Playwright runtime (LOCK-OBSERVER-001/003).
 */
import { describe, expect, it } from 'vitest'

import {
  PERF_STREAM_OBSERVER_MODE_ENV,
  TREATMENT_CODE,
  observerBenchmarkId,
  observerBenchmarkName,
  observerModeGateEnabled,
  observerScaleMap,
  resolveObserverMode,
  type ObserverMode
} from './perfStreamObserverControl'

const ORIGINAL_ENV = process.env[PERF_STREAM_OBSERVER_MODE_ENV]

function withEnv(value: string | undefined, fn: () => void): void {
  const previous = process.env[PERF_STREAM_OBSERVER_MODE_ENV]
  if (value === undefined) delete process.env[PERF_STREAM_OBSERVER_MODE_ENV]
  else process.env[PERF_STREAM_OBSERVER_MODE_ENV] = value
  try {
    fn()
  } finally {
    if (previous === undefined) delete process.env[PERF_STREAM_OBSERVER_MODE_ENV]
    else process.env[PERF_STREAM_OBSERVER_MODE_ENV] = previous
  }
}

describe('resolveObserverMode', () => {
  it('resolves scan and noscan to the correct treatment codes', () => {
    withEnv('scan', () => {
      const m = resolveObserverMode()
      expect(m).toBe('scan')
      expect(TREATMENT_CODE[m]).toBe(0)
    })
    withEnv('SCAN', () => {
      const m = resolveObserverMode()
      expect(m).toBe('scan')
      expect(TREATMENT_CODE[m]).toBe(0)
    })
    withEnv('noscan', () => {
      const m = resolveObserverMode()
      expect(m).toBe('noscan')
      expect(TREATMENT_CODE[m]).toBe(1)
    })
    withEnv(' NOSCAN ', () => {
      const m = resolveObserverMode()
      expect(m).toBe('noscan')
      expect(TREATMENT_CODE[m]).toBe(1)
    })
  })

  it('throws on an unsupported non-empty value', () => {
    withEnv('both', () => expect(() => resolveObserverMode()).toThrow(/expected "scan" or "noscan"/))
    withEnv('bogus', () => expect(() => resolveObserverMode()).toThrow(/unsupported/))
    withEnv('1', () => expect(() => resolveObserverMode()).toThrow(/unsupported/))
  })

  it('env-gate is true only for an explicit non-empty mode (unset/empty skips; invalid values are NOT skipped so they fail in the resolver)', () => {
    withEnv(undefined, () => expect(observerModeGateEnabled()).toBe(false))
    withEnv('', () => expect(observerModeGateEnabled()).toBe(false))
    withEnv('   ', () => expect(observerModeGateEnabled()).toBe(false))
    withEnv('scan', () => expect(observerModeGateEnabled()).toBe(true))
    withEnv('noscan', () => expect(observerModeGateEnabled()).toBe(true))
    // An explicit but unsupported value is still "requested": the gate must NOT
    // skip it — resolveObserverMode() throws fail-loud instead.
    withEnv('both', () => expect(observerModeGateEnabled()).toBe(true))
    withEnv('bogus', () => expect(observerModeGateEnabled()).toBe(true))
  })
})

describe('observerBenchmarkId', () => {
  it('encodes profile kind and treatment in the benchmark id', () => {
    expect(observerBenchmarkId('n1', 'scan')).toBe('chatdb-stream-render-observer-e2e-scan-n1')
    expect(observerBenchmarkId('n2', 'noscan')).toBe('chatdb-stream-render-observer-e2e-noscan-n2')
    expect(observerBenchmarkId('n3', 'scan')).toBe('chatdb-stream-render-observer-e2e-scan-n3')
  })

  it('is distinct from ATTR-002 benchmark ids', () => {
    expect(observerBenchmarkId('n1', 'scan')).not.toBe('chatdb-stream-render-e2e-n1')
    expect(observerBenchmarkId('n1', 'noscan')).not.toBe('chatdb-stream-render-e2e-n1')
  })
})

describe('observerBenchmarkName', () => {
  it('includes N count, mode, and measurement slice identifier', () => {
    const name = observerBenchmarkName('n2', 'noscan', 2)
    expect(name).toContain('N=2')
    expect(name).toContain('noscan')
    expect(name).toContain('PERF-STREAM-ATTR-003')
  })
})

describe('observerScaleMap', () => {
  const baseArgs = {
    profileKind: 'n1',
    mode: 'scan' as ObserverMode,
    mentionModelCount: 1,
    samplesPerProfile: 3,
    probeCountPerSample: 6,
    streamParagraphs: 150,
    streamChunkDelayMs: 60,
    reduxEventTotal: 100,
    domEventTotal: 80,
    inputProbeTotal: 18,
    longTasks: 5,
    frames: 200
  }

  it('includes base fields for both treatments', () => {
    const scanMap = observerScaleMap(baseArgs)
    expect(scanMap.treatmentCode).toBe(0)
    expect(scanMap.mentionModelCount).toBe(1)
    expect(scanMap.reduxEventTotal).toBe(100)

    const noscanMap = observerScaleMap({ ...baseArgs, mode: 'noscan' })
    expect(noscanMap.treatmentCode).toBe(1)
    expect(noscanMap.mentionModelCount).toBe(1)
  })

  it('includes scan mechanism fields only for scan treatment', () => {
    const scanMetrics = { scanInvocations: 42, scanTotalTimeMs: 15.5, scanTotalBytes: 8000 }
    const scanMap = observerScaleMap(baseArgs, scanMetrics)
    expect(scanMap.scanInvocations).toBe(42)
    expect(scanMap.scanTotalTimeMs).toBe(15.5)
    expect(scanMap.scanTotalBytes).toBe(8000)

    const noscanMap = observerScaleMap({ ...baseArgs, mode: 'noscan' })
    expect(noscanMap.scanInvocations).toBeUndefined()
    expect(noscanMap.scanTotalTimeMs).toBeUndefined()
    expect(noscanMap.scanTotalBytes).toBeUndefined()
  })

  it('omits scan mechanism fields for scan treatment when no scanMetrics provided', () => {
    const scanMap = observerScaleMap(baseArgs)
    expect(scanMap.scanInvocations).toBeUndefined()
    expect(scanMap.scanTotalTimeMs).toBeUndefined()
    expect(scanMap.scanTotalBytes).toBeUndefined()
  })

  it('all values are finite numbers (schema v1 contract)', () => {
    const map = observerScaleMap(baseArgs, {
      scanInvocations: 10,
      scanTotalTimeMs: 5.2,
      scanTotalBytes: 4000
    })
    for (const [key, value] of Object.entries(map)) {
      expect(Number.isFinite(value), `scale.${key} must be finite`).toBe(true)
    }
  })
})

// Restore the env so the test file leaves no side effects.
describe('env hygiene', () => {
  it('restores the original PERF_STREAM_OBSERVER_MODE value', () => {
    expect(process.env[PERF_STREAM_OBSERVER_MODE_ENV]).toBe(ORIGINAL_ENV)
  })
})
