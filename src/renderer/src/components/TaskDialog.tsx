import { Modal } from 'antd'
import type { FC, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'

import { getTopViewLayerCount, popTopViewLayer, subscribeTopViewLayerCount } from './TopView/layers'

// Mounted task dialogs. A route switch unmounts the old dialog and mounts its
// successor in the same commit; the deferred restore below reads this to see
// that another task surface inherited focus and must not jump back to Chat.
let liveTaskDialogs = 0

// Focus the prior owner only when it can still legitimately take focus, and
// only when nothing else already did. Reading `activeElement` here (rather than
// unconditionally focusing) keeps a close that moved focus somewhere usable
// untouched.
const restoreFocusOwner = (owner: HTMLElement | null) => {
  if (!owner || !owner.isConnected) return
  if (liveTaskDialogs > 0) return
  // A nested TopView popup is layered above the task: it owns focus until it
  // closes, and the task itself (not Chat) gets it back afterwards.
  if (getTopViewLayerCount() > 0) return
  const active = document.activeElement
  if (active && active !== document.body && active.isConnected) return
  try {
    owner.focus({ preventScroll: true })
  } catch {
    // A stale/foreign owner must never break the close path.
  }
}

interface TaskDialogProps {
  /**
   * Task title (localized by the caller). Never rendered as visible chrome: the
   * shell has no header row. A string title becomes the native dialog's
   * accessible name (see the seam effect below).
   */
  title: ReactNode
  /** Task content (the LazyRoute page element). Loading/error states stay inside. */
  children: ReactNode
  /** Close action: navigate to '/' — never history-back out of the app. */
  onClose: () => void
  /** Task width bucket. Settings uses a narrower dialog than management pages. */
  width: number
}

const TASK_DIALOG_MAX_HEIGHT = 'min(760px, calc(100dvh - 48px))'

/**
 * Centered in-app modal task shell for secondary pages (Files, Knowledge, Settings).
 *
 * Contract (route-dialog overlay):
 * - The route path stays usable for shortcut/deeplink/provider query semantics;
 *   closing navigates explicitly to '/', never history-back out of the app.
 * - Home stays mounted and visible behind the dialog; only one task surface is
 *   open at a time (Router renders at most one TaskDialog).
 * - The shell is a headerless floating panel: no title row and no close button
 *   (`closable={false}`, `title` undefined), so the body owns the full available
 *   height. Antd's own surface styling (border, radius, shadow) is untouched.
 * - It dismisses like a floating panel: a click OUTSIDE the panel (`maskClosable`
 *   backdrop) or Escape closes it; a click inside never does (rc-dialog ignores
 *   wrapper clicks that did not target the wrapper itself, and suppresses a drag
 *   that starts inside the content). `onCancel` is the single close path for
 *   both, and it is gated by the topmost-layer rule below.
 * - Antd Modal provides focus trap / restore / aria roles; the mask blocks
 *   pointer input while Chat remains visually attached behind it.
 * - `destroyOnHidden` keeps mount/unmount semantics aligned with the previous
 *   route-mount behavior and preserves guarded content loading state.
 * - The `modalRender` wrapper is a style-only (`display:contents`) seam carrying
 *   `task-dialog` (rc-dialog does not forward data-* to its panel node). It
 *   carries no role: antd owns the single `role="dialog"` and its title.
 * - Accessible name without a header: rc-dialog derives `aria-labelledby` from
 *   its `title` prop and does not forward arbitrary aria props from Modal, so a
 *   headerless shell would be unnamed. The seam effect below applies the task
 *   title as `aria-label` on that single native `role="dialog"` element, keeping
 *   the announced task identity while no title row is rendered.
 * - Nested TopView children (Add Provider, Add Knowledge, …) portal outside
 *   this dialog's React subtree, so their Escape never reaches this dialog —
 *   but Escape *inside* this dialog would otherwise close the parent and
 *   orphan the child. While a TopView child is open the parent yields:
 *   `keyboard` is off, and the seam's own keydown boundary (an ancestor of the
 *   dialog panel, so bubbling reaches it before the wrapper's Escape handler)
 *   closes only the topmost TopView child. Inner overlays that consume Escape
 *   (Select/Picker dropdowns, menus) stop propagation first, so they keep
 *   priority; IME composition is never stolen. The same topmost rule gates
 *   `onCancel`, so a backdrop click aimed at a layered child can never close
 *   the parent behind it.
 * - Focus ownership survives a route-driven close. rc-dialog restores the
 *   saved outside owner only in its leave-motion callback, which the route's
 *   immediate unmount bypasses; `destroyOnHidden` + navigate('/') would leave
 *   focus on `body`. The prior owner is captured on the first render — before
 *   antd focuses the dialog — and handed back after the unmounted portal is
 *   gone (`preventScroll`, so the chat viewport never moves). The restore is
 *   skipped when the owner is gone, when a nested popup owns focus, and when
 *   another task dialog already took over (task-to-task switch). With no
 *   genuine owner before opening (mouse on a non-focusable control), nothing
 *   is forced.
 */
export const TaskDialog: FC<TaskDialogProps> = ({ title, children, onClose, width }) => {
  const [nestedOpen, setNestedOpen] = useState(() => getTopViewLayerCount() > 0)
  const seamRef = useRef<HTMLDivElement | null>(null)

  // First render is the only moment the pre-open owner is still focused: antd
  // focuses the dialog panel right after mount. Capture once, never re-capture
  // on re-renders or route switches.
  const focusOwner = useRef<HTMLElement | null | undefined>(undefined)
  if (focusOwner.current === undefined) {
    const active = document.activeElement
    // A dialog portal's own node is never a valid "prior owner": it disappears
    // with its dialog (task-to-task switch), so capture nothing instead.
    const owner =
      active instanceof HTMLElement && active !== document.body && !active.closest('[data-testid="task-dialog"]')
        ? active
        : null
    focusOwner.current = owner
  }

  useEffect(() => subscribeTopViewLayerCount((count) => setNestedOpen(count > 0)), [])

  // Route-driven close: restore ownership once the unmounted portal is gone.
  // Deferred by a microtask so the same commit's task-route switch (if any) has
  // mounted its dialog first — `liveTaskDialogs` then keeps focus on the task.
  useEffect(() => {
    liveTaskDialogs += 1
    return () => {
      liveTaskDialogs -= 1
      const owner = focusOwner.current ?? null
      queueMicrotask(() => restoreFocusOwner(owner))
    }
  }, [])

  // No visible header means no `title` prop for rc-dialog to build
  // `aria-labelledby` from, so the accessible name travels to the single native
  // dialog element itself. Route callers pass localized strings; a non-string
  // title carries no announceable text and simply leaves the name unset.
  const accessibleName = typeof title === 'string' ? title : null
  useEffect(() => {
    const dialogEl = seamRef.current?.closest('[role="dialog"]')
    if (!dialogEl) return
    if (!accessibleName) return
    dialogEl.setAttribute('aria-label', accessibleName)
    return () => dialogEl.removeAttribute('aria-label')
  }, [accessibleName])

  const handleNestedEscape = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Escape') return
    if (e.nativeEvent.isComposing) return
    if (getTopViewLayerCount() === 0) return
    // A TopView child is layered above this task: close only the topmost
    // child and keep the parent open. The parent's own Escape stays disabled
    // via `keyboard` below while nested.
    e.stopPropagation()
    popTopViewLayer()
  }

  const handleCancel = () => {
    // Same topmost rule as the Escape path: while a TopView child is layered
    // above this task, an outside/backdrop click belongs to that topmost layer
    // (or to a sibling overlay subtree that bubbled here) and must never close
    // the parent behind the child. Read the live layer count rather than the
    // `nestedOpen` snapshot so a just-opened child always wins.
    if (getTopViewLayerCount() > 0) return
    onClose()
  }

  return (
    <Modal
      centered
      closable={false}
      destroyOnHidden
      footer={null}
      keyboard={!nestedOpen}
      mask
      maskClosable
      onCancel={handleCancel}
      open
      width={width}
      modalRender={(node) => (
        <div ref={seamRef} data-testid="task-dialog" onKeyDown={handleNestedEscape} style={{ display: 'contents' }}>
          {node}
        </div>
      )}
      styles={{
        content: {
          height: TASK_DIALOG_MAX_HEIGHT,
          maxHeight: TASK_DIALOG_MAX_HEIGHT,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          padding: 0
        },
        body: {
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          padding: 0
        }
      }}>
      {children}
    </Modal>
  )
}

export default TaskDialog
