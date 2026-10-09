/**
 * Renderer-side send-timing diagnostics (LOCK-001..LOCK-004).
 *
 * - Binds an opaque per-send correlation id + 1-based append ordinal for the
 *   ordinary send path, so the two appendMessage calls of one send (user then
 *   assistant) and their main-process counterparts share a correlation id.
 * - Correlation ownership is EXPLICIT and per-send: `sendMessage` creates one
 *   `SendDiagnosticsContext` and threads it through its append calls, so
 *   overlapping sends across topics or interleaved append callers can never
 *   attribute another send's context (LOCK-004). There is no module-global
 *   "active send" slot.
 * - Emits bounded, privacy-safe timing logs that are forwarded to the main
 *   log file via `logToMain`, so renderer and main entries for a single
 *   append/send can be correlated in one file.
 *
 * No message content, prompts, keys, paths, or raw request objects are ever
 * logged; only stage names, durations, the opaque correlation id, ordinal,
 * success/failure, and non-sensitive counts/booleans.
 */

import { loggerService } from '@logger'
import type { AppendDiagnostics } from '@shared/chatDb'
import {
  formatDuration,
  MAX_APPEND_DIAGNOSTIC_LOGS,
  newCorrelationId,
  shouldLogDiagnosticStage
} from '@shared/diagnostics/sendTiming'

// ---------------------------------------------------------------------------
// Send context — explicit per-send correlation object (LOCK-004)
// ---------------------------------------------------------------------------

/**
 * Per-send correlation context. One instance is created by the ordinary
 * send path (`sendMessage`) and threaded explicitly through that send's
 * user and assistant append calls down to `SqliteMessageDataSource`.
 *
 * Because each send owns its own context object, overlapping sends never
 * share or clobber correlation state: ordinals are always consumed from
 * the caller's own context.
 */
export interface SendDiagnosticsContext {
  /** Opaque per-send correlation id shared by renderer and main log entries. */
  correlationId: string
  /** Next 1-based ordinal to assign; advanced on each consumed append. */
  nextOrdinal: number
}

/** Create a fresh send correlation context (called once per ordinary send). */
export function createSendDiagnosticsContext(): SendDiagnosticsContext {
  return { correlationId: newCorrelationId(), nextOrdinal: 1 }
}

/**
 * Consume the next append slot from the caller's OWN send context.
 *
 * Ordinal assignment is 1 for the user append and 2+ for assistant
 * stubs/multi-model appends of the same send. Returns undefined when no
 * context is supplied (append not part of the ordinary send path — no
 * diagnostics, preserving prior behavior exactly).
 */
export function consumeNextAppendDiagnostics(ctx: SendDiagnosticsContext | undefined): AppendDiagnostics | undefined {
  if (!ctx) {
    return undefined
  }
  const diagnostics: AppendDiagnostics = {
    correlationId: ctx.correlationId,
    ordinal: ctx.nextOrdinal
  }
  ctx.nextOrdinal += 1
  return diagnostics
}

// ---------------------------------------------------------------------------
// Bounded emission
// ---------------------------------------------------------------------------

export interface AppendDiagnosticData {
  correlationId: string
  ordinal?: number
  ok: boolean
  messageIdPresent?: boolean
  blockCount?: number
}

/**
 * Emit an append-stage timing log (bounded to the first few sends per
 * process lifetime, LOCK-003) and forward it to the main log file.
 */
export function logAppendDiagnostic(stage: string, durationMs: number, data: AppendDiagnosticData): void {
  if (!shouldLogDiagnosticStage(stage, MAX_APPEND_DIAGNOSTIC_LOGS)) {
    return
  }
  loggerService.withContext('sendTiming').info(
    `[diagnostics] ${stage}`,
    {
      ...data,
      durationMs,
      duration: formatDuration(durationMs)
    },
    { logToMain: true }
  )
}

/**
 * Emit a conditional cold-path timing log (bounded per stage, LOCK-003) and
 * forward it to the main log file for cross-process correlation.
 */
export function logColdPathDiagnostic(stage: string, durationMs: number, data: Record<string, unknown>): void {
  if (!shouldLogDiagnosticStage(stage)) {
    return
  }
  loggerService.withContext('sendTiming').info(
    `[diagnostics] ${stage}`,
    {
      ...data,
      durationMs,
      duration: formatDuration(durationMs)
    },
    { logToMain: true }
  )
}
