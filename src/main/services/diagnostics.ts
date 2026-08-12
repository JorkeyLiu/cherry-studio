/**
 * Main-process diagnostics emission helper (LOCK-001..LOCK-004).
 *
 * Emits bounded, privacy-safe timing logs through loggerService into the
 * daily app log file. Only stage names, durations, the opaque correlation
 * id, ordinal, success/failure, and non-sensitive counts/booleans are
 * logged — never message content, prompts, keys, paths, or raw requests.
 */

import { loggerService } from '@logger'
import { formatDuration, shouldLogDiagnosticStage } from '@shared/diagnostics/sendTiming'

/**
 * Emit a main-side diagnostic timing log, bounded per stage to the first few
 * attempts per process lifetime (LOCK-003).
 *
 * @param stage       Stable stage name, e.g. 'main.append.tx'.
 * @param durationMs  Monotonic elapsed milliseconds (performance.now()).
 * @param limit       Per-stage budget; append stages pass the append budget,
 *                    cold-path stages default to the cold-path budget.
 * @param data        Non-sensitive correlation metadata (correlationId,
 *                    ordinal, ok, counts/booleans). Never sensitive values.
 */
export function logMainDiagnostic(
  stage: string,
  durationMs: number,
  limit: number,
  data: Record<string, unknown>
): void {
  if (!shouldLogDiagnosticStage(stage, limit)) {
    return
  }
  loggerService.withContext('sendTiming').info(`[diagnostics] ${stage}`, {
    ...data,
    durationMs,
    duration: formatDuration(durationMs)
  })
}
