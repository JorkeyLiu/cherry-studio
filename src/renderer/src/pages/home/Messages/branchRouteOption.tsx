import type { KeyboardEvent } from 'react'
import { useEffect, useRef } from 'react'

/**
 * Shared inline-rename input behaviour for branch rows.
 *
 * Enter or blur commits the draft, Escape cancels it without a follow-up
 * blur commit. Cancelling unmounts the editor, which can still emit a blur:
 * the cancel path arms a guard first so that blur never reaches
 * `onCommitRename`, and starting the next edit disarms it again. Used by the
 * shared branch-route tree panel (both the top selector and the fork-divider
 * trees render their rows through it).
 */

export function useBranchRenameInput(args: {
  renaming: boolean
  onCommitRename: () => void
  onCancelRename: () => void
}): {
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  onBlur: () => void
} {
  const { renaming, onCommitRename, onCancelRename } = args
  const renameCancelled = useRef(false)
  useEffect(() => {
    if (renaming) renameCancelled.current = false
  }, [renaming])
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape') return
    // Cancelling the edit is the whole intent: keep the surrounding popover
    // open (Escape would otherwise also close it).
    event.preventDefault()
    event.stopPropagation()
    renameCancelled.current = true
    onCancelRename()
  }
  const onBlur = (): void => {
    if (renameCancelled.current) return
    onCommitRename()
  }
  return { onKeyDown, onBlur }
}
