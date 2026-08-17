/**
 * PERF-STREAM-ATTR-003 — observer load control treatment resolver (E2E-only).
 *
 * Measurement-only helper module for the production-build E2E control slice
 * `perf-stream-render-observer-control.spec.ts` (docs/performance-workstreams.md
 * §2.2 PERF-STREAMING; slice PERF-STREAM-ATTR-003). It holds the observer mode
 * resolution (scan vs noscan treatment) and the combined profile-key derivation
 * used by the spec's skip gate, correctness gates, and artifact identity.
 *
 * LOCK-OBSERVER-001: E2E/test-only measurement change; no production code
 * changes.
 * LOCK-OBSERVER-002: treatmentCode 0 (scan) / 1 (noscan); artifact ids encode
 * profile and treatment.
 * LOCK-OBSERVER-003: wrong/invalid env fails loudly; default unset skips.
 */

// ---------------------------------------------------------------------------
// Observer mode (treatment)
// ---------------------------------------------------------------------------

/** Env var selecting the observer treatment. */
export const PERF_STREAM_OBSERVER_MODE_ENV = 'PERF_STREAM_OBSERVER_MODE'

/** Treatment identity. */
export type ObserverMode = 'scan' | 'noscan'

/** Numeric treatment code recorded in the schema-v1 scale map. */
export const TREATMENT_CODE: Record<ObserverMode, number> = { scan: 0, noscan: 1 }

/**
 * Resolve the observer treatment from the runner env. Throws on an unsupported
 * non-empty value (fail-loud before any measurement); the empty/unset case is
 * handled by the spec's `test.skip` (default-off), so this throws defensively
 * only if called without an explicit mode.
 */
export function resolveObserverMode(): ObserverMode {
  const raw = (process.env[PERF_STREAM_OBSERVER_MODE_ENV] ?? '').trim().toLowerCase()
  switch (raw) {
    case 'scan':
      return 'scan'
    case 'noscan':
      return 'noscan'
    default:
      throw new Error(
        `[PERF-STREAM-ATTR-003] unsupported ${PERF_STREAM_OBSERVER_MODE_ENV}="${raw}" — expected "scan" or "noscan" (unset/empty = spec skipped by default)`
      )
  }
}

/**
 * True when the runner explicitly requested a treatment (a non-empty, trimmed
 * env value) — the spec's default-off skip decision (env-gate). Unset/empty
 * skips the measurement spec; ANY non-empty value (valid or invalid) returns
 * true so an invalid value is NOT skipped here but reaches
 * `resolveObserverMode`, which throws fail-loud before any measurement.
 */
export function observerModeGateEnabled(): boolean {
  const raw = (process.env[PERF_STREAM_OBSERVER_MODE_ENV] ?? '').trim()
  return raw.length > 0
}

// ---------------------------------------------------------------------------
// Combined profile key (N-scaling × treatment)
// ---------------------------------------------------------------------------

/**
 * Build the schema-v1 benchmark id for a given N-scaling profile kind and
 * observer treatment. The id encodes both dimensions for unambiguous artifact
 * identity (LOCK-OBSERVER-002).
 *
 * @param profileKind - 'n1' | 'n2' | 'n3' (from PERF_STREAM_RENDER_SCALE)
 * @param mode - 'scan' | 'noscan' (from PERF_STREAM_OBSERVER_MODE)
 */
export function observerBenchmarkId(profileKind: string, mode: ObserverMode): string {
  return `chatdb-stream-render-observer-e2e-${mode}-${profileKind}`
}

/**
 * Build the schema-v1 benchmark name for a given N-scaling profile kind and
 * observer treatment.
 */
export function observerBenchmarkName(profileKind: string, mode: ObserverMode, mentionModelCount: number): string {
  return `PERF-STREAM-ATTR-003 N=${mentionModelCount} ${mode} treatment ` + `(production-build E2E, Electron lane)`
}

/**
 * Derive the schema-v1 scale map for the observer control artifact. All fields
 * are finite numbers (schema v1 contract). Includes the treatment code and
 * scan-mode mechanism fields when applicable.
 */
export function observerScaleMap(
  args: {
    profileKind: string
    mode: ObserverMode
    mentionModelCount: number
    samplesPerProfile: number
    probeCountPerSample: number
    streamParagraphs: number
    streamChunkDelayMs: number
    reduxEventTotal: number
    domEventTotal: number
    inputProbeTotal: number
    longTasks: number
    frames: number
  },
  scanMetrics?: {
    scanInvocations: number
    scanTotalTimeMs: number
    scanTotalBytes: number
  }
): Record<string, number> {
  const base: Record<string, number> = {
    treatmentCode: TREATMENT_CODE[args.mode],
    profileCode: args.profileKind === 'n1' ? 0 : args.profileKind === 'n2' ? 1 : 2,
    mentionModelCount: args.mentionModelCount,
    samplesPerProfile: args.samplesPerProfile,
    probeCountPerSample: args.probeCountPerSample,
    streamParagraphs: args.streamParagraphs,
    streamChunkDelayMs: args.streamChunkDelayMs,
    reduxEventTotal: args.reduxEventTotal,
    domEventTotal: args.domEventTotal,
    inputProbeTotal: args.inputProbeTotal,
    longTaskTotal: args.longTasks,
    frameTotal: args.frames
  }
  if (args.mode === 'scan' && scanMetrics) {
    base.scanInvocations = scanMetrics.scanInvocations
    base.scanTotalTimeMs = scanMetrics.scanTotalTimeMs
    base.scanTotalBytes = scanMetrics.scanTotalBytes
  }
  return base
}
