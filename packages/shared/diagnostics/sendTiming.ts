/**
 * Shared diagnostic primitives for bounded, privacy-safe first-send timing
 * diagnostics (LOCK-001..LOCK-004).
 *
 * - `shouldLogDiagnosticStage` bounds log volume to the first few attempts
 *   per stage per process lifetime (LOCK-003).
 * - `newCorrelationId` generates an opaque, non-sensitive correlation id used
 *   to link renderer and main log entries for one append/send (LOCK-004).
 * - `elapsedMs` / `formatDuration` provide consistent monotonic-clock
 *   durations (`performance.now()`).
 *
 * Dependency-free: no Electron/Node imports — safe for renderer, main, and
 * the shared unit-test lane. No message content, prompts, keys, paths, or
 * request objects ever flow through this module.
 */

/**
 * Append-stage budget: ~the first three sends per process lifetime
 * (each send performs two appendMessage calls — user then assistant).
 */
export const MAX_APPEND_DIAGNOSTIC_LOGS = 6

/** Cold-path budget: the first three initializations per stage per process. */
export const MAX_COLD_PATH_DIAGNOSTIC_LOGS = 3

/** Per-stage attempt counters (process lifetime). */
const diagnosticStageCounts = new Map<string, number>()

/**
 * Whether a diagnostic stage is still within its bounded budget.
 *
 * Every ATTEMPT consumes budget (success and failure alike) so a failure
 * loop can never produce unbounded logs. The counter advances on each call,
 * so callers should invoke this exactly once per intended log emission.
 *
 * @param stage  Stable stage name, e.g. 'renderer.append.serialize'.
 * @param limit  Per-stage cap; append stages pass MAX_APPEND_DIAGNOSTIC_LOGS,
 *               cold-path stages default to MAX_COLD_PATH_DIAGNOSTIC_LOGS.
 */
export function shouldLogDiagnosticStage(stage: string, limit: number = MAX_COLD_PATH_DIAGNOSTIC_LOGS): boolean {
  const seen = diagnosticStageCounts.get(stage) ?? 0
  if (seen >= limit) {
    return false
  }
  diagnosticStageCounts.set(stage, seen + 1)
  return true
}

/** Clear all per-stage counters. Test seam only; never called in production. */
export function resetDiagnosticCounters(): void {
  diagnosticStageCounts.clear()
}

/**
 * Generate an opaque, non-sensitive correlation id for one send.
 * Contains no user data; safe for logs and IPC request metadata.
 */
export function newCorrelationId(): string {
  return `snd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Milliseconds elapsed since a `performance.now()` start, rounded to 0.1 ms.
 * Monotonic and consistent across renderer and main (LOCK: monotonic clock).
 */
export function elapsedMs(startTime: number): number {
  return Math.round((performance.now() - startTime) * 10) / 10
}

/** Human-readable, consistent duration for log messages. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) {
    return `${ms}ms`
  }
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`
  }
  if (ms >= 1) {
    return `${ms.toFixed(1)}ms`
  }
  return `${Math.round(ms * 1000)}µs`
}
