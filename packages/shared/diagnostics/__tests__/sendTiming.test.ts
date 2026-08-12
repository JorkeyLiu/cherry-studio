import { afterEach, describe, expect, it } from 'vitest'

import {
  elapsedMs,
  formatDuration,
  MAX_APPEND_DIAGNOSTIC_LOGS,
  MAX_COLD_PATH_DIAGNOSTIC_LOGS,
  newCorrelationId,
  resetDiagnosticCounters,
  shouldLogDiagnosticStage
} from '../sendTiming'

describe('sendTiming diagnostics primitives', () => {
  afterEach(() => {
    resetDiagnosticCounters()
  })

  describe('shouldLogDiagnosticStage — bounded volume (LOCK-003)', () => {
    it('logs the first MAX_COLD_PATH_DIAGNOSTIC_LOGS attempts per stage', () => {
      const stage = 'cold.path'
      const results: boolean[] = []
      for (let i = 0; i < MAX_COLD_PATH_DIAGNOSTIC_LOGS + 3; i++) {
        results.push(shouldLogDiagnosticStage(stage))
      }
      expect(results.filter(Boolean)).toHaveLength(MAX_COLD_PATH_DIAGNOSTIC_LOGS)
      expect(results.slice(MAX_COLD_PATH_DIAGNOSTIC_LOGS).every((r) => r === false)).toBe(true)
    })

    it('consumes budget on every attempt, success and failure alike', () => {
      // Simulate: 3 successful emissions then 3 failed emissions.
      for (let i = 0; i < MAX_COLD_PATH_DIAGNOSTIC_LOGS; i++) {
        expect(shouldLogDiagnosticStage('fail.loop')).toBe(true)
      }
      for (let i = 0; i < 10; i++) {
        expect(shouldLogDiagnosticStage('fail.loop')).toBe(false)
      }
    })

    it('uses a separate budget per stage', () => {
      expect(shouldLogDiagnosticStage('stage.a')).toBe(true)
      expect(shouldLogDiagnosticStage('stage.a')).toBe(true)
      expect(shouldLogDiagnosticStage('stage.b')).toBe(true)
    })

    it('honors an explicit append-stage limit', () => {
      for (let i = 0; i < MAX_APPEND_DIAGNOSTIC_LOGS; i++) {
        expect(shouldLogDiagnosticStage('renderer.append.ipc', MAX_APPEND_DIAGNOSTIC_LOGS)).toBe(true)
      }
      expect(shouldLogDiagnosticStage('renderer.append.ipc', MAX_APPEND_DIAGNOSTIC_LOGS)).toBe(false)
    })

    it('resetDiagnosticCounters restores the full budget', () => {
      expect(shouldLogDiagnosticStage('reset.me')).toBe(true)
      expect(shouldLogDiagnosticStage('reset.me')).toBe(true)
      expect(shouldLogDiagnosticStage('reset.me')).toBe(true)
      resetDiagnosticCounters()
      expect(shouldLogDiagnosticStage('reset.me')).toBe(true)
    })
  })

  describe('newCorrelationId — correlation (LOCK-004)', () => {
    it('generates opaque non-sensitive ids that are unique across calls', () => {
      const ids = new Set<string>()
      for (let i = 0; i < 50; i++) {
        ids.add(newCorrelationId())
      }
      expect(ids.size).toBe(50)
      for (const id of ids) {
        expect(id.startsWith('snd-')).toBe(true)
        expect(id).toMatch(/^snd-[a-z0-9]+-[a-z0-9]+$/)
        expect(id.length).toBeLessThanOrEqual(64)
      }
    })
  })

  describe('elapsedMs / formatDuration — monotonic consistent durations', () => {
    it('elapsedMs returns a non-negative finite rounded number', () => {
      const start = performance.now()
      const elapsed = elapsedMs(start)
      expect(Number.isFinite(elapsed)).toBe(true)
      expect(elapsed).toBeGreaterThanOrEqual(0)
    })

    it('formatDuration renders consistent units', () => {
      expect(formatDuration(0.4)).toBe('400µs')
      expect(formatDuration(5)).toBe('5.0ms')
      expect(formatDuration(123.45)).toBe('123.5ms')
      expect(formatDuration(1500)).toBe('1.50s')
    })
  })
})
