import {
  createHistoryTokenEstimateSession,
  type EstimateHistoryMessageFn,
  type HistoryTokenEstimateSession
} from '@renderer/services/historyTokenEstimateSession'
import { estimateDraftTokens, type LocalTokenEstimate } from '@renderer/services/LocalTokenEstimator'
import { combineHistoryAndDraftTokens, estimateHistoryTokens } from '@renderer/services/TokenService'
import type { Assistant, FileMetadata } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import type { SnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
import { debounce } from 'lodash'
import { useEffect, useRef, useState } from 'react'

/**
 * Default debounce for prompt-token estimation. History + draft estimation is
 * async and content-based; a short debounce coalesces rapid keystrokes and
 * attachment mutations into a single concurrent estimation pass.
 */
export const PROMPT_TOKEN_ESTIMATE_DEBOUNCE_MS = 200

/** Injectable history estimator (defaults to TokenService). */
export type EstimateHistoryFn = (
  assistant: Assistant,
  messages: Message[],
  snapshotBlocks?: SnapshotBlockMap
) => Promise<number>
/** Injectable draft estimator (defaults to LocalTokenEstimator). */
export type EstimateDraftFn = (params: { content?: string; files?: FileMetadata[] }) => Promise<LocalTokenEstimate>

/**
 * Stable default history estimator: adapts the TokenService options-object
 * signature to the hook's positional snapshot-pairing contract. Module-level
 * so the hook's effect dependency stays referentially stable.
 */
const defaultEstimateHistory: EstimateHistoryFn = (assistant, messages, snapshotBlocks) =>
  estimateHistoryTokens(assistant, messages, { snapshotBlocks })

/**
 * Route/anchor identity that scopes a history estimation session. The hook
 * never derives authority from it (no pending/count/boundary semantics) — it
 * only decides when the previous route's cached per-message estimates must
 * be dropped so entries stay bounded and never leak across routes.
 */
export interface PromptTokenRouteIdentity {
  topicId: string
  branchId?: string | null
  anchorGroupKey?: string | null
}
export interface UsePromptTokenEstimateOptions {
  /** Assistant supplying the system-prompt token estimate. */
  assistant: Assistant
  /**
   * Canonical, already-selected messages for token estimation
   * (`tokenEstimationMessages` from `computeContextInfo`). This hook does NOT
   * re-window or re-filter — it estimates over exactly what it receives.
   */
  tokenEstimationMessages: Message[]
  /**
   * Explicit block snapshot paired with `tokenEstimationMessages` (the
   * `blockSnapshot` from the shared context derivation). The debounced pass
   * captures this pair together so a later store change cannot re-read new
   * block content under old messages.
   */
  blockSnapshot?: SnapshotBlockMap
  /** Current draft text for the next request. */
  text: string
  /** Current draft attachments for the next request. */
  files: FileMetadata[]
  /** Debounce window; defaults to {@link PROMPT_TOKEN_ESTIMATE_DEBOUNCE_MS}. */
  debounceMs?: number
  /** Test seam: override the history estimator (legacy path only). */
  estimateHistory?: EstimateHistoryFn
  /** Test seam: override the draft estimator. */
  estimateDraft?: EstimateDraftFn
  /**
   * Route/anchor identity for the history estimation session. When provided,
   * history is estimated through a bounded per-identity session that reuses
   * stable per-message estimates instead of re-tokenizing unchanged history
   * every run. An identity change resets the session; unmount clears it. The
   * legacy `estimateHistory` whole-history estimator is ignored on this path.
   */
  routeIdentity?: PromptTokenRouteIdentity
  /**
   * Media-context switch for history estimation on the session path: when
   * false, historical image/audio/video payloads are not counted. A change
   * invalidates cached per-message results. Defaults to true.
   */
  includeMedia?: boolean
  /** Test seam: per-message history estimator used by the session. */
  estimateHistoryMessage?: EstimateHistoryMessageFn
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
  blockSnapshot,
  text,
  files,
  debounceMs = PROMPT_TOKEN_ESTIMATE_DEBOUNCE_MS,
  estimateHistory = defaultEstimateHistory,
  estimateDraft = estimateDraftTokens,
  routeIdentity,
  includeMedia = true,
  estimateHistoryMessage
}: UsePromptTokenEstimateOptions): number {
  const [estimateTokenCount, setEstimateTokenCount] = useState(0)

  // Monotonic request identity. Every effect run claims the next id; only the
  // newest id may commit a result. Guards against stale-A-after-B races.
  const requestIdRef = useRef(0)

  // Bounded history session: explicit-snapshot UI path only. Keyed by
  // route/anchor identity; identity change or unmount drops the previous
  // route's entries (no cross-route reuse, no global map).
  const useSession = routeIdentity !== undefined
  const identityKey = routeIdentity
    ? [routeIdentity.topicId, routeIdentity.branchId ?? '', routeIdentity.anchorGroupKey ?? ''].join('|')
    : 'default'
  const sessionRef = useRef<{ key: string; session: HistoryTokenEstimateSession } | null>(null)

  useEffect(() => {
    if (!useSession) {
      return
    }
    return () => {
      sessionRef.current?.session.reset()
      sessionRef.current = null
    }
  }, [useSession, identityKey])

  useEffect(() => {
    const requestId = ++requestIdRef.current
    let cancelled = false

    const isCurrent = () => !cancelled && requestId === requestIdRef.current

    const getSession = (): HistoryTokenEstimateSession => {
      const current = sessionRef.current
      if (current && current.key === identityKey) {
        return current.session
      }
      const session = createHistoryTokenEstimateSession(
        estimateHistoryMessage ? { estimateMessage: estimateHistoryMessage } : {}
      )
      sessionRef.current = { key: identityKey, session }
      return session
    }

    const run = debounce(
      () => {
        const historyPromise = useSession
          ? getSession().estimateHistory(assistant, tokenEstimationMessages, {
              includeMedia,
              snapshotBlocks: blockSnapshot
            })
          : estimateHistory(assistant, tokenEstimationMessages, blockSnapshot)
        Promise.all([historyPromise, estimateDraft({ content: text, files })])
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
  }, [
    assistant,
    tokenEstimationMessages,
    blockSnapshot,
    text,
    files,
    debounceMs,
    estimateHistory,
    estimateDraft,
    estimateHistoryMessage,
    identityKey,
    includeMedia,
    useSession
  ])

  return estimateTokenCount
}
