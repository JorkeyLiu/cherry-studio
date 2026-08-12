import type { Dispatch, SetStateAction } from 'react'
import { startTransition } from 'react'

/**
 * Schedule a parsed-content commit as non-urgent React work (LOCK-002 cadence).
 *
 * LOCK-001 race guard: the commit does not capture the text at schedule time.
 * Instead the functional state updater reads the latest authoritative text via
 * `readLatest` AT COMMIT TIME. Completion / error / pause / reset always update
 * the authoritative ref before they flush, so a pending cadence transition that
 * commits after the urgent final flush re-applies the exact final content
 * instead of overwriting it with stale streaming text.
 */
export function scheduleParsedContentCommit(
  setParsedContent: Dispatch<SetStateAction<string>>,
  readLatest: () => string
): void {
  startTransition(() => {
    setParsedContent(() => readLatest())
  })
}
