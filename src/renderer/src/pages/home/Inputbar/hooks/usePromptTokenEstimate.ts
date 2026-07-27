import { estimateDraftTokens, type LocalTokenEstimate } from '@renderer/services/LocalTokenEstimator'
import { combineHistoryAndDraftTokens, estimateHistoryTokens } from '@renderer/services/TokenService'
import type { Assistant, FileMetadata } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { debounce } from 'lodash'
import { useEffect, useRef, useState } from 'react'

/**
 * Default debounce for prompt-token estimation. History + draft estimation is
 * async and content-based; a short debounce coalesces rapid keystrokes and
 * attachment mutations into a single concurrent estimation pass.
 */
export const PROMPT_TOKEN_ESTIMATE_DEBOUNCE_MS = 200

/** Injectable history estimator (defaults to TokenService). */
export type EstimateHistoryFn = (assistant: Assistant, messages: Message[]) => Promise<number>
/** Injectable draft estimator (defaults to LocalTokenEstimator). */
export type EstimateDraftFn = (params: { content?: string; files?: FileMetadata[] }) => Promise<LocalTokenEstimate>

export interface UsePromptTokenEstimateOptions {
  /** Assistant supplying the system-prompt token estimate. */
  assistant: Assistant
  /**
   * Canonical, already-selected messages for token estimation
   * (`tokenEstimationMessages` from `computeContextInfo`). This hook does NOT
   * re-window or re-filter — it estimates over exactly what it receives.
   */
  tokenEstimationMessages: Message[]
  /** Current draft text for the next request. */
  text: string
  /** Current draft attachments for the next request. */
  files: FileMetadata[]
  /** Debounce window; defaults to {@link PROMPT_TOKEN_ESTIMATE_DEBOUNCE_MS}. */
  debounceMs?: number
  /** Test seam: override the history estimator. */
  estimateHistory?: EstimateHistoryFn
  /** Test seam: override the draft estimator. */
  estimateDraft?: EstimateDraftFn
}

/**
 * Focused, race-safe async prompt-token estimation for the Inputbar preview.
 *
 * Behaviour (LOCK-001, LOCK-005, LOCK-009):
 * - Debounces, then estimates selected history and the current draft
 *   (text + attachments) concurrently, combining them into a single scalar.
 * - Draft attachments are estimated via the shared draft estimator; this hook
 *   holds no file/converter classification logic (LOCK-004).
 * - A monotonic request id plus a per-run cancellation flag guard every state
 *   write: a stale in-flight estimate can never overwrite a newer one, and no
 *   write occurs after unmount or dependency change.
 * - On estimation failure the last valid scalar is preserved (never zeroed).
 *
 * @returns Combined `history + draft` token estimate for display.
 */
export function usePromptTokenEstimate({
  assistant,
  tokenEstimationMessages,
  text,
  files,
  debounceMs = PROMPT_TOKEN_ESTIMATE_DEBOUNCE_MS,
  estimateHistory = estimateHistoryTokens,
  estimateDraft = estimateDraftTokens
}: UsePromptTokenEstimateOptions): number {
  const [estimateTokenCount, setEstimateTokenCount] = useState(0)

  // Monotonic request identity. Every effect run claims the next id; only the
  // newest id may commit a result. Guards against stale-A-after-B races.
  const requestIdRef = useRef(0)

  useEffect(() => {
    const requestId = ++requestIdRef.current
    let cancelled = false

    const isCurrent = () => !cancelled && requestId === requestIdRef.current

    const run = debounce(
      () => {
        Promise.all([estimateHistory(assistant, tokenEstimationMessages), estimateDraft({ content: text, files })])
          .then(([historyTokens, draftEstimate]) => {
            if (!isCurrent()) {
              return
            }
            setEstimateTokenCount(combineHistoryAndDraftTokens(historyTokens, draftEstimate.totalTokens))
          })
          .catch(() => {
            // Estimation failure is non-fatal: preserve the last valid scalar
            // rather than zeroing the whole preview (LOCK-009).
          })
      },
      debounceMs,
      { leading: false, trailing: true }
    )

    run()

    return () => {
      cancelled = true
      run.cancel()
    }
  }, [assistant, tokenEstimationMessages, text, files, debounceMs, estimateHistory, estimateDraft])

  return estimateTokenCount
}
