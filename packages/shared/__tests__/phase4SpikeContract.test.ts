/**
 * Tests for Phase 4.0-A spike IPC contract validation.
 *
 * These are pure-function tests that verify the validation logic
 * rejects malformed/invalid payloads — covering acceptance criterion 4
 * (invalid sender/request path rejection) without a second renderer.
 */
import { describe, expect, it } from 'vitest'

import {
  generateCaseId,
  generateRequestId,
  generateRunId,
  getExpectedResponseOperation,
  REQUEST_TO_RESPONSE_OPERATION,
  SPIKE_OPERATIONS,
  validateSpikeRequest,
  validateSpikeResult
} from '../phase4SpikeContract'

describe('phase4SpikeContract', () => {
  /* ── ID generators ── */

  describe('ID generators', () => {
    it('generateRunId returns unique strings with run- prefix', () => {
      const a = generateRunId()
      const b = generateRunId()
      expect(a).toMatch(/^run-/)
      expect(b).toMatch(/^run-/)
      expect(a).not.toBe(b)
    })

    it('generateCaseId returns unique strings with case- prefix', () => {
      const a = generateCaseId()
      const b = generateCaseId()
      expect(a).toMatch(/^case-/)
      expect(b).toMatch(/^case-/)
      expect(a).not.toBe(b)
    })

    it('generateRequestId returns unique strings with req- prefix', () => {
      const a = generateRequestId()
      const b = generateRequestId()
      expect(a).toMatch(/^req-/)
      expect(b).toMatch(/^req-/)
      expect(a).not.toBe(b)
    })
  })

  /* ── validateSpikeRequest ── */

  describe('validateSpikeRequest', () => {
    const validRequest = {
      runId: 'run-123',
      caseId: 'case-456',
      requestId: 'req-789',
      operation: 'PING' as const
    }

    it('accepts a valid PING request', () => {
      expect(validateSpikeRequest(validRequest)).toEqual({ valid: true })
    })

    it('accepts a valid PONG request', () => {
      expect(validateSpikeRequest({ ...validRequest, operation: 'PONG' })).toEqual({ valid: true })
    })

    it('accepts request with optional payload', () => {
      expect(validateSpikeRequest({ ...validRequest, payload: { foo: 'bar' } })).toEqual({ valid: true })
    })

    // Rejection: null / non-object
    it('rejects null', () => {
      expect(validateSpikeRequest(null).valid).toBe(false)
    })

    it('rejects undefined', () => {
      expect(validateSpikeRequest(undefined).valid).toBe(false)
    })

    it('rejects a string', () => {
      expect(validateSpikeRequest('not-an-object').valid).toBe(false)
    })

    it('rejects a number', () => {
      expect(validateSpikeRequest(42).valid).toBe(false)
    })

    it('rejects an array', () => {
      expect(validateSpikeRequest([validRequest]).valid).toBe(false)
    })

    // Rejection: missing fields
    it('rejects missing runId', () => {
      const { runId: _, ...rest } = validRequest
      expect(validateSpikeRequest(rest).valid).toBe(false)
    })

    it('rejects empty runId', () => {
      expect(validateSpikeRequest({ ...validRequest, runId: '' }).valid).toBe(false)
    })

    it('rejects missing caseId', () => {
      const { caseId: _, ...rest } = validRequest
      expect(validateSpikeRequest(rest).valid).toBe(false)
    })

    it('rejects empty caseId', () => {
      expect(validateSpikeRequest({ ...validRequest, caseId: '' }).valid).toBe(false)
    })

    it('rejects missing requestId', () => {
      const { requestId: _, ...rest } = validRequest
      expect(validateSpikeRequest(rest).valid).toBe(false)
    })

    it('rejects empty requestId', () => {
      expect(validateSpikeRequest({ ...validRequest, requestId: '' }).valid).toBe(false)
    })

    it('rejects missing operation', () => {
      const { operation: _, ...rest } = validRequest
      expect(validateSpikeRequest(rest).valid).toBe(false)
    })

    // Rejection: invalid operation
    it('rejects unknown operation', () => {
      expect(validateSpikeRequest({ ...validRequest, operation: 'EVIL' }).valid).toBe(false)
    })

    it('rejects empty operation', () => {
      expect(validateSpikeRequest({ ...validRequest, operation: '' }).valid).toBe(false)
    })

    it('rejects numeric operation', () => {
      expect(validateSpikeRequest({ ...validRequest, operation: 1 }).valid).toBe(false)
    })

    // Rejection: wrong types
    it('rejects numeric runId', () => {
      expect(validateSpikeRequest({ ...validRequest, runId: 123 }).valid).toBe(false)
    })

    it('rejects boolean caseId', () => {
      expect(validateSpikeRequest({ ...validRequest, caseId: true }).valid).toBe(false)
    })
  })

  /* ── validateSpikeResult ── */

  describe('validateSpikeResult', () => {
    const validResult = {
      runId: 'run-123',
      caseId: 'case-456',
      requestId: 'req-789',
      operation: 'PONG' as const,
      status: 'ok' as const
    }

    it('accepts a valid ok result', () => {
      expect(validateSpikeResult(validResult)).toEqual({ valid: true })
    })

    it('accepts a valid error result', () => {
      expect(validateSpikeResult({ ...validResult, status: 'error', error: 'boom' })).toEqual({ valid: true })
    })

    it('accepts a valid rejected result', () => {
      expect(validateSpikeResult({ ...validResult, status: 'rejected' })).toEqual({ valid: true })
    })

    it('accepts result with optional payload', () => {
      expect(validateSpikeResult({ ...validResult, payload: { key: 'value' } })).toEqual({ valid: true })
    })

    // Rejection: null / non-object
    it('rejects null', () => {
      expect(validateSpikeResult(null).valid).toBe(false)
    })

    it('rejects undefined', () => {
      expect(validateSpikeResult(undefined).valid).toBe(false)
    })

    it('rejects a string', () => {
      expect(validateSpikeResult('not-an-object').valid).toBe(false)
    })

    // Rejection: missing fields
    it('rejects missing runId', () => {
      const { runId: _, ...rest } = validResult
      expect(validateSpikeResult(rest).valid).toBe(false)
    })

    it('rejects missing caseId', () => {
      const { caseId: _, ...rest } = validResult
      expect(validateSpikeResult(rest).valid).toBe(false)
    })

    it('rejects missing requestId', () => {
      const { requestId: _, ...rest } = validResult
      expect(validateSpikeResult(rest).valid).toBe(false)
    })

    it('rejects missing operation', () => {
      const { operation: _, ...rest } = validResult
      expect(validateSpikeResult(rest).valid).toBe(false)
    })

    it('rejects missing status', () => {
      const { status: _, ...rest } = validResult
      expect(validateSpikeResult(rest).valid).toBe(false)
    })

    // Rejection: invalid status
    it('rejects unknown status', () => {
      expect(validateSpikeResult({ ...validResult, status: 'invalid' }).valid).toBe(false)
    })

    it('rejects empty status', () => {
      expect(validateSpikeResult({ ...validResult, status: '' }).valid).toBe(false)
    })

    // Rejection: invalid operation
    it('rejects unknown operation in result', () => {
      expect(validateSpikeResult({ ...validResult, operation: 'STEAL_DATA' }).valid).toBe(false)
    })

    // Rejection: wrong types
    it('rejects numeric runId', () => {
      expect(validateSpikeResult({ ...validResult, runId: 999 }).valid).toBe(false)
    })
  })

  /* ── SPIKE_OPERATIONS constant ── */

  describe('SPIKE_OPERATIONS', () => {
    it('contains PING, PONG, FIXTURE_GENERATE, FIXTURE_DONE, VERIFY, VERIFY_DONE, ISOLATION_SETUP, ISOLATION_SETUP_DONE, ORIGIN_PROBE, ORIGIN_PROBE_DONE, LS_CHECK, LS_CHECK_DONE', () => {
      expect(Object.values(SPIKE_OPERATIONS)).toEqual([
        'PING',
        'PONG',
        'FIXTURE_GENERATE',
        'FIXTURE_DONE',
        'VERIFY',
        'VERIFY_DONE',
        'ISOLATION_SETUP',
        'ISOLATION_SETUP_DONE',
        'ORIGIN_PROBE',
        'ORIGIN_PROBE_DONE',
        'LS_CHECK',
        'LS_CHECK_DONE'
      ])
    })
  })

  /* ── FIXTURE operations validation ── */

  describe('FIXTURE operations', () => {
    const validFixtureRequest = {
      runId: 'run-123',
      caseId: 'case-456',
      requestId: 'req-789',
      operation: 'FIXTURE_GENERATE' as const,
      payload: { fixtureId: 'v4', databaseName: 'CherryStudio' }
    }

    const validFixtureResult = {
      runId: 'run-123',
      caseId: 'case-456',
      requestId: 'req-789',
      operation: 'FIXTURE_DONE' as const,
      status: 'ok' as const,
      payload: {
        fixtureId: 'v4',
        logicalDexieVersion: 4,
        observedNativeVersion: 40,
        markers: {},
        localStorage: {},
        tables: ['files'],
        recordCounts: { files: 1 },
        limitations: []
      }
    }

    it('accepts FIXTURE_GENERATE request', () => {
      expect(validateSpikeRequest(validFixtureRequest)).toEqual({ valid: true })
    })

    it('accepts FIXTURE_DONE result', () => {
      expect(validateSpikeResult(validFixtureResult)).toEqual({ valid: true })
    })

    it('accepts FIXTURE_DONE error result', () => {
      expect(validateSpikeResult({ ...validFixtureResult, status: 'error', error: 'boom' })).toEqual({ valid: true })
    })

    it('still rejects unknown operations after extension', () => {
      expect(validateSpikeRequest({ ...validFixtureRequest, operation: 'MALICIOUS' }).valid).toBe(false)
      expect(validateSpikeResult({ ...validFixtureResult, operation: 'MALICIOUS' }).valid).toBe(false)
    })
  })

  /* ── VERIFY operations validation (Phase C1) ── */

  describe('VERIFY operations', () => {
    const validVerifyRequest = {
      runId: 'run-123',
      caseId: 'case-456',
      requestId: 'req-789',
      operation: 'VERIFY' as const,
      payload: { fixtureId: 'v4', expectedNativeVersion: 40 }
    }

    const validVerifyResult = {
      runId: 'run-123',
      caseId: 'case-456',
      requestId: 'req-789',
      operation: 'VERIFY_DONE' as const,
      status: 'ok' as const,
      payload: {
        fixtureId: 'v4',
        preflight: {
          locationHref: 'file:///tmp/test/phase4Spike.html',
          locationOrigin: 'file://',
          nativeVersion: 40,
          expectedVersion: 40,
          cherryStudioFound: true
        },
        productionOpenerStarted: true,
        productionOpenerCompleted: true
      }
    }

    it('accepts VERIFY request', () => {
      expect(validateSpikeRequest(validVerifyRequest)).toEqual({ valid: true })
    })

    it('accepts VERIFY_DONE result', () => {
      expect(validateSpikeResult(validVerifyResult)).toEqual({ valid: true })
    })

    it('accepts VERIFY_DONE error result', () => {
      expect(validateSpikeResult({ ...validVerifyResult, status: 'error', error: 'boom' })).toEqual({ valid: true })
    })

    it('accepts VERIFY_DONE rejected result', () => {
      expect(
        validateSpikeResult({
          ...validVerifyResult,
          status: 'rejected',
          payload: { ...validVerifyResult.payload, futureVersionRejected: true }
        })
      ).toEqual({ valid: true })
    })

    it('still rejects unknown operations after VERIFY extension', () => {
      expect(validateSpikeRequest({ ...validVerifyRequest, operation: 'EVIL' }).valid).toBe(false)
      expect(validateSpikeResult({ ...validVerifyResult, operation: 'EVIL' }).valid).toBe(false)
    })
  })

  /* ── ISOLATION_SETUP / ORIGIN_PROBE operations validation (Phase C2a) ── */

  describe('C2a operations', () => {
    const validIsolationSetupRequest = {
      runId: 'run-123',
      caseId: 'case-456',
      requestId: 'req-789',
      operation: 'ISOLATION_SETUP' as const,
      payload: { markerValue: 'sentinel-test-123' }
    }

    const validIsolationSetupResult = {
      runId: 'run-123',
      caseId: 'case-456',
      requestId: 'req-789',
      operation: 'ISOLATION_SETUP_DONE' as const,
      status: 'ok' as const,
      payload: {
        sentinelDbName: 'C2aSentinel',
        markerValue: 'sentinel-test-123',
        recordCount: 1,
        roundTripVerified: true
      }
    }

    const validOriginProbeRequest = {
      runId: 'run-123',
      caseId: 'case-456',
      requestId: 'req-789',
      operation: 'ORIGIN_PROBE' as const
    }

    const validOriginProbeResult = {
      runId: 'run-123',
      caseId: 'case-456',
      requestId: 'req-789',
      operation: 'ORIGIN_PROBE_DONE' as const,
      status: 'ok' as const,
      payload: {
        databases: [{ name: 'C2aSentinel', version: 1 }],
        cherryStudioFound: false,
        sentinelFound: true,
        origin: 'file://',
        href: 'file:///tmp/test/phase4Spike.html'
      }
    }

    it('accepts ISOLATION_SETUP request', () => {
      expect(validateSpikeRequest(validIsolationSetupRequest)).toEqual({ valid: true })
    })

    it('accepts ISOLATION_SETUP_DONE result', () => {
      expect(validateSpikeResult(validIsolationSetupResult)).toEqual({ valid: true })
    })

    it('accepts ISOLATION_SETUP_DONE error result', () => {
      expect(validateSpikeResult({ ...validIsolationSetupResult, status: 'error', error: 'create failed' })).toEqual({
        valid: true
      })
    })

    it('accepts ORIGIN_PROBE request', () => {
      expect(validateSpikeRequest(validOriginProbeRequest)).toEqual({ valid: true })
    })

    it('accepts ORIGIN_PROBE_DONE result', () => {
      expect(validateSpikeResult(validOriginProbeResult)).toEqual({ valid: true })
    })

    it('accepts ORIGIN_PROBE_DONE error result', () => {
      expect(validateSpikeResult({ ...validOriginProbeResult, status: 'error', error: 'probe failed' })).toEqual({
        valid: true
      })
    })

    it('still rejects unknown operations after C2a extension', () => {
      expect(validateSpikeRequest({ ...validIsolationSetupRequest, operation: 'EVIL' }).valid).toBe(false)
      expect(validateSpikeResult({ ...validIsolationSetupResult, operation: 'EVIL' }).valid).toBe(false)
      expect(validateSpikeRequest({ ...validOriginProbeRequest, operation: 'EVIL' }).valid).toBe(false)
      expect(validateSpikeResult({ ...validOriginProbeResult, operation: 'EVIL' }).valid).toBe(false)
    })
  })

  /* ── LS_CHECK operations validation (Phase C2b) ── */

  describe('C2b operations', () => {
    const validLsCheckRequest = {
      runId: 'run-123',
      caseId: 'case-456',
      requestId: 'req-789',
      operation: 'LS_CHECK' as const
    }

    const validLsCheckResult = {
      runId: 'run-123',
      caseId: 'case-456',
      requestId: 'req-789',
      operation: 'LS_CHECK_DONE' as const,
      status: 'ok' as const,
      payload: {
        allKeys: ['phase4:marker', 'phase4:fixtureId'],
        markerFound: true,
        markerValue: 'A',
        fixtureIdFound: true,
        fixtureIdValue: 'v11a',
        origin: 'file://',
        href: 'file:///tmp/test/phase4Spike.html'
      }
    }

    it('accepts LS_CHECK request', () => {
      expect(validateSpikeRequest(validLsCheckRequest)).toEqual({ valid: true })
    })

    it('accepts LS_CHECK_DONE result', () => {
      expect(validateSpikeResult(validLsCheckResult)).toEqual({ valid: true })
    })

    it('accepts LS_CHECK_DONE error result', () => {
      expect(validateSpikeResult({ ...validLsCheckResult, status: 'error', error: 'ls not available' })).toEqual({
        valid: true
      })
    })

    it('accepts LS_CHECK_DONE with empty localStorage', () => {
      const emptyLsResult = {
        ...validLsCheckResult,
        payload: {
          allKeys: [],
          markerFound: false,
          markerValue: null,
          fixtureIdFound: false,
          fixtureIdValue: null,
          origin: 'file://',
          href: 'file:///tmp/test/phase4Spike.html'
        }
      }
      expect(validateSpikeResult(emptyLsResult)).toEqual({ valid: true })
    })

    it('still rejects unknown operations after C2b extension', () => {
      expect(validateSpikeRequest({ ...validLsCheckRequest, operation: 'EVIL' }).valid).toBe(false)
      expect(validateSpikeResult({ ...validLsCheckResult, operation: 'EVIL' }).valid).toBe(false)
    })
  })

  /* ── Request→Response operation mapping ── */

  describe('REQUEST_TO_RESPONSE_OPERATION', () => {
    it('maps every request operation to exactly one response operation', () => {
      expect(REQUEST_TO_RESPONSE_OPERATION.size).toBe(6)
    })

    it('maps PING → PONG', () => {
      expect(REQUEST_TO_RESPONSE_OPERATION.get('PING')).toBe('PONG')
    })

    it('maps FIXTURE_GENERATE → FIXTURE_DONE', () => {
      expect(REQUEST_TO_RESPONSE_OPERATION.get('FIXTURE_GENERATE')).toBe('FIXTURE_DONE')
    })

    it('maps VERIFY → VERIFY_DONE', () => {
      expect(REQUEST_TO_RESPONSE_OPERATION.get('VERIFY')).toBe('VERIFY_DONE')
    })

    it('maps ISOLATION_SETUP → ISOLATION_SETUP_DONE', () => {
      expect(REQUEST_TO_RESPONSE_OPERATION.get('ISOLATION_SETUP')).toBe('ISOLATION_SETUP_DONE')
    })

    it('maps ORIGIN_PROBE → ORIGIN_PROBE_DONE', () => {
      expect(REQUEST_TO_RESPONSE_OPERATION.get('ORIGIN_PROBE')).toBe('ORIGIN_PROBE_DONE')
    })

    it('maps LS_CHECK → LS_CHECK_DONE', () => {
      expect(REQUEST_TO_RESPONSE_OPERATION.get('LS_CHECK')).toBe('LS_CHECK_DONE')
    })

    it('does not map response operations', () => {
      expect(REQUEST_TO_RESPONSE_OPERATION.has('PONG')).toBe(false)
      expect(REQUEST_TO_RESPONSE_OPERATION.has('FIXTURE_DONE')).toBe(false)
      expect(REQUEST_TO_RESPONSE_OPERATION.has('VERIFY_DONE')).toBe(false)
      expect(REQUEST_TO_RESPONSE_OPERATION.has('ISOLATION_SETUP_DONE')).toBe(false)
      expect(REQUEST_TO_RESPONSE_OPERATION.has('ORIGIN_PROBE_DONE')).toBe(false)
      expect(REQUEST_TO_RESPONSE_OPERATION.has('LS_CHECK_DONE')).toBe(false)
    })
  })

  describe('getExpectedResponseOperation', () => {
    it('returns PONG for PING', () => {
      expect(getExpectedResponseOperation('PING')).toBe('PONG')
    })

    it('returns FIXTURE_DONE for FIXTURE_GENERATE', () => {
      expect(getExpectedResponseOperation('FIXTURE_GENERATE')).toBe('FIXTURE_DONE')
    })

    it('returns VERIFY_DONE for VERIFY', () => {
      expect(getExpectedResponseOperation('VERIFY')).toBe('VERIFY_DONE')
    })

    it('returns ISOLATION_SETUP_DONE for ISOLATION_SETUP', () => {
      expect(getExpectedResponseOperation('ISOLATION_SETUP')).toBe('ISOLATION_SETUP_DONE')
    })

    it('returns ORIGIN_PROBE_DONE for ORIGIN_PROBE', () => {
      expect(getExpectedResponseOperation('ORIGIN_PROBE')).toBe('ORIGIN_PROBE_DONE')
    })

    it('returns LS_CHECK_DONE for LS_CHECK', () => {
      expect(getExpectedResponseOperation('LS_CHECK')).toBe('LS_CHECK_DONE')
    })

    it('returns undefined for response operations (not request operations)', () => {
      expect(getExpectedResponseOperation('PONG' as any)).toBeUndefined()
      expect(getExpectedResponseOperation('FIXTURE_DONE' as any)).toBeUndefined()
      expect(getExpectedResponseOperation('VERIFY_DONE' as any)).toBeUndefined()
      expect(getExpectedResponseOperation('ISOLATION_SETUP_DONE' as any)).toBeUndefined()
      expect(getExpectedResponseOperation('ORIGIN_PROBE_DONE' as any)).toBeUndefined()
      expect(getExpectedResponseOperation('LS_CHECK_DONE' as any)).toBeUndefined()
    })

    it('rejects a result with mismatched operation (not the expected response)', () => {
      // Simulate: request was ISOLATION_SETUP, but result says ORIGIN_PROBE_DONE
      const mismatchedResult = {
        runId: 'run-123',
        caseId: 'case-456',
        requestId: 'req-789',
        operation: 'ORIGIN_PROBE_DONE', // wrong — expected ISOLATION_SETUP_DONE
        status: 'ok' as const
      }
      // The result is structurally valid (valid operation, valid status)
      expect(validateSpikeResult(mismatchedResult)).toEqual({ valid: true })
      // But getExpectedResponseOperation shows the mismatch
      const expected = getExpectedResponseOperation('ISOLATION_SETUP')
      expect(expected).toBe('ISOLATION_SETUP_DONE')
      expect(mismatchedResult.operation).not.toBe(expected)
    })
  })
})
