/**
 * B-01–B-05 synthetic calibration benchmark.
 *
 * Default-inert. Enabled runs use only deterministic synthetic payloads and
 * emit the existing schema-v1 numeric artifact after all tasks and gates pass.
 * No production retention, eviction, TTL, LRU, persistence, or user data is
 * accessed.
 */

import { afterAll, bench, describe, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:os')
vi.unmock('node:path')
vi.unmock('node:crypto')

import {
  B0105_CALIBRATION_COMMAND,
  B0105_CALIBRATION_ENV,
  B0105_CALIBRATION_SCALE_ENV,
  B0105_SCALES,
  resolveB0105Gate,
  resolveB0105Scale,
  summarizeB0105Calibration
} from './b0105Calibration'
import { assembleB0105CalibrationResult } from './b0105Calibration.benchContract'
import { collectEnvironmentMetadata, emitBenchmarkResultAfterSuccessfulTasksAndGates } from './benchResult'

const enabled = resolveB0105Gate(process.env[B0105_CALIBRATION_ENV])

if (!enabled) {
  describe('B-01–B-05 synthetic calibration (on-demand)', () => {
    bench.skip(
      'B-01–B-05 calibration skipped — enable via pnpm bench:b0105-calibration (B0105_CALIBRATION=1)',
      () => {}
    )
  })
} else {
  const scaleKey = resolveB0105Scale(process.env[B0105_CALIBRATION_SCALE_ENV])
  const summary = summarizeB0105Calibration(B0105_SCALES[scaleKey])
  const result = assembleB0105CalibrationResult({
    summary,
    environment: collectEnvironmentMetadata({ command: B0105_CALIBRATION_COMMAND })
  })

  describe(`B-01–B-05 synthetic calibration — ${scaleKey}`, () => {
    bench(
      'recompute synthetic logical-boundary and fit-step accounting',
      () => {
        summarizeB0105Calibration(B0105_SCALES[scaleKey])
      },
      { warmupIterations: 1, iterations: 2 }
    )
  })

  afterAll((suite) => {
    const artifactPath = emitBenchmarkResultAfterSuccessfulTasksAndGates(suite, result)
    if (artifactPath !== null) process.stdout.write(`Result artifact: ${artifactPath}\n`)
  })
}
