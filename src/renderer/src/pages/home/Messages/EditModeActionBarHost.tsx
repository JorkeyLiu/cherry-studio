import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

interface EditModeActionBarHostProps {
  children: ReactNode
}

/**
 * Hit layer for the owner-only edit-mode action bar (true-branch edit pill).
 *
 * The overlay titlebar (`chat-titlebar`) is a full-width absolute drag root
 * (z 6) sitting as a sibling ABOVE the chat canvas (`ChatCanvas` z 0 with
 * `isolation: isolate`). A bar rendered inside the canvas keeps its own
 * z 10 flattened by that isolation, so the top-overlapped pill hits land on
 * the titlebar — visible and enabled, but never clickable.
 *
 * The host portals the bar into the titlebar's own stacking context (below
 * the left/right control floats, above the fade and the blank drag pixels),
 * escaping the canvas isolation without touching canvas paint order. Without
 * a titlebar host (isolated mounts, tests) it falls back to the inline
 * position. The bar itself stays `pointer-events: none` full-width with a
 * `pointer-events: auto` + `no-drag` pill, so blank titlebar drag and the
 * floating controls behave exactly as before in both modes.
 */
const EditModeActionBarHost = ({ children }: EditModeActionBarHostProps) => {
  const [titlebar, setTitlebar] = useState<HTMLElement | null>(null)

  useEffect(() => {
    try {
      const host = document.querySelector('#chat-main [data-testid="chat-titlebar"]')
      setTitlebar(host instanceof HTMLElement ? host : null)
    } catch {
      setTitlebar(null)
    }
  }, [])

  if (titlebar) return createPortal(children, titlebar)
  return <>{children}</>
}

export default EditModeActionBarHost
