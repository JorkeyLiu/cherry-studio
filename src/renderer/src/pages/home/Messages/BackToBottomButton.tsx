import { ChevronDown } from 'lucide-react'
import type { FC, RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

/**
 * Genuine physical bottom gate (renderer-local geometry only):
 * `abs(scrollTop) <= 1`. Mirrors the canonical `isGenuinePhysicalBottom`
 * in Messages.tsx (kept there by the streaming-follow visual contract);
 * duplicated here so this lightweight button never imports the full
 * Messages module. 1px is subpixel rounding tolerance — never the 50px
 * snapshot vicinity.
 */
const isAtGenuineBottom = (scrollTop: unknown): boolean =>
  typeof scrollTop === 'number' && Number.isFinite(scrollTop) && Math.abs(scrollTop) <= 1

interface BackToBottomButtonProps {
  /** Canonical explicit bottom navigation (Messages scrollToBottom). */
  onScrollToBottom: () => void
  /** Live scroll container; falls back to `#messages` when absent. */
  containerRef?: RefObject<HTMLElement | null>
  /**
   * Newer completeness from the authoritative Messages window flow
   * (`viewportState.window.hasMoreNewer`, which already merges the validated
   * Main `hasMoreAfter` with bounded-trim derivation). `true` means newer
   * messages exist beyond the current projection, so the button stays visible
   * even at the physical bottom. `false`/absent means the projection is
   * complete through newest (empty projections report `false` via the
   * existing `?? false` at the call site — vacuous completeness, never a
   * fabricated incomplete). Loading-newer retains the window's `true`, so no
   * separate loading prop is needed.
   */
  hasMoreNewer?: boolean
}

const readScrollTop = (container: HTMLElement | null): number | null => {
  if (!container) return null
  const value = container.scrollTop
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Independent compact back-to-bottom button for the chat viewport.
 *
 * - Always available, independent of the conversation-navigation setting.
 * - Visibility derives from the genuine physical bottom
 *   (`abs(scrollTop) <= 1px`; the 50px snapshot vicinity never counts) AND
 *   the authoritative newer completeness: hidden only when physically at the
 *   bottom with no newer messages beyond the current projection
 *   (`hasMoreNewer === false`). A historical window parked at scrollTop 0
 *   with `hasMoreNewer === true` stays visible — physical bottom is the
 *   window's lower edge, not the newest bottom.
 * - Re-evaluated on scroll, resize, and content growth (streaming/geometry
 *   changes), so it appears whenever the viewport is away from the bottom.
 * - Click calls the canonical explicit bottom navigation (follow intent);
 *   no new scrolling ownership, controller, or persisted state.
 */
const BackToBottomButton: FC<BackToBottomButtonProps> = ({ onScrollToBottom, containerRef, hasMoreNewer }) => {
  const { t } = useTranslation()
  const [isAtBottom, setIsAtBottom] = useState(true)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const resolveContainer = useCallback((): HTMLElement | null => {
    const fromRef = containerRef?.current ?? null
    if (fromRef && fromRef.isConnected) return fromRef
    return document.getElementById('messages')
  }, [containerRef])

  const refresh = useCallback(() => {
    const top = readScrollTop(resolveContainer())
    if (top === null) return
    setIsAtBottom((prev) => {
      const next = isAtGenuineBottom(top)
      return prev === next ? prev : next
    })
  }, [resolveContainer])

  useEffect(() => {
    refresh()
    const container = resolveContainer()
    if (!container) return
    const onScroll = (): void => refresh()
    container.addEventListener('scroll', onScroll, { passive: true })
    let resizeObserver: ResizeObserver | null = null
    try {
      resizeObserver = new ResizeObserver(() => refresh())
      resizeObserver.observe(container)
    } catch {
      resizeObserver = null
    }
    let mutationObserver: MutationObserver | null = null
    try {
      mutationObserver = new MutationObserver(() => refresh())
      mutationObserver.observe(container, { childList: true, subtree: true, characterData: true })
    } catch {
      mutationObserver = null
    }
    return () => {
      container.removeEventListener('scroll', onScroll)
      try {
        resizeObserver?.disconnect()
      } catch {}
      try {
        mutationObserver?.disconnect()
      } catch {}
    }
  }, [refresh, resolveContainer])

  // Newest-bottom semantics: the physical gate alone cannot decide. A
  // historical window whose lower edge sits at scrollTop 0 still has newer
  // messages beyond the projection (`hasMoreNewer === true`), so the button
  // stays visible there. Hidden only when physically at the bottom AND the
  // current projection is complete through newest.
  const hasNewerBeyondProjection = hasMoreNewer === true
  if (isAtBottom && !hasNewerBeyondProjection) return null

  return (
    <BottomButton
      ref={buttonRef}
      type="button"
      data-testid="conversation-back-to-bottom"
      aria-label={t('chat.navigation.bottom')}
      title={t('chat.navigation.bottom')}
      onClick={onScrollToBottom}>
      <ChevronDown size={16} />
    </BottomButton>
  )
}

const BottomButton = styled.button`
  position: absolute;
  right: 16px;
  bottom: 12px;
  z-index: 6;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px solid var(--color-border);
  background: var(--color-background);
  color: var(--color-text-2);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  cursor: pointer;
  transition:
    color 0.2s ease-in-out,
    background 0.2s ease-in-out,
    box-shadow 0.2s ease-in-out;

  &:hover {
    background: var(--color-hover);
    color: var(--color-text-1);
  }

  &:focus-visible {
    outline: 2px solid var(--color-text-3);
    outline-offset: 2px;
  }

  .anticon {
    font-size: 16px;
  }
`

export default BackToBottomButton
