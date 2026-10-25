import { throttle } from 'lodash'
import type { FC } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import styled from 'styled-components'

export interface ScrollbarProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onScroll'> {
  ref?: React.Ref<HTMLDivElement | null>
  onScroll?: () => void // Custom onScroll prop for useScrollPosition's handleScroll
}

const Scrollbar: FC<ScrollbarProps> = ({ ref: passedRef, children, onScroll: externalOnScroll, ...htmlProps }) => {
  // isScrolling drives ONLY the thumb paint via an inherited CSS variable on
  // the host inline style. The host styled class stays identical across
  // scroll gestures: the previous `$isScrolling` styled interpolation
  // replaced the host class mid-gesture (transparent <-> thumb rule), which
  // rebuilt the scrollable layout object and aborted the in-flight native
  // smooth paging. Inline custom-property inheritance repaints the
  // `::-webkit-scrollbar-thumb` without touching host class/overflow rules.
  // The 1500ms visible-fade semantics are unchanged.
  const [isScrolling, setIsScrolling] = useState(false)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  const clearScrollingTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const handleScroll = useCallback(() => {
    setIsScrolling(true)
    clearScrollingTimeout()
    timeoutRef.current = setTimeout(() => {
      setIsScrolling(false)
      timeoutRef.current = null
    }, 1500)
  }, [clearScrollingTimeout])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const throttledInternalScrollHandler = useCallback(throttle(handleScroll, 100, { leading: true, trailing: true }), [
    handleScroll
  ])

  // Combined scroll handler
  const combinedOnScroll = useCallback(() => {
    throttledInternalScrollHandler()
    if (externalOnScroll) {
      externalOnScroll()
    }
  }, [throttledInternalScrollHandler, externalOnScroll])

  useEffect(() => {
    return () => {
      clearScrollingTimeout()
      throttledInternalScrollHandler.cancel()
    }
  }, [throttledInternalScrollHandler, clearScrollingTimeout])

  const { style: htmlStyle, ...restHtmlProps } = htmlProps
  return (
    <ScrollBarContainer
      {...restHtmlProps} // Pass other HTML attributes
      style={
        {
          ...htmlStyle,
          '--scrollbar-thumb-color': isScrolling ? 'var(--color-scrollbar-thumb)' : 'transparent'
        } as React.CSSProperties
      }
      onScroll={combinedOnScroll} // Use the combined handler
      ref={passedRef}>
      {children}
    </ScrollBarContainer>
  )
}

const ScrollBarContainer = styled.div`
  overflow-y: auto;
  scrollbar-gutter: stable;
  &::-webkit-scrollbar-thumb {
    transition: background 2s ease;
    background: var(--scrollbar-thumb-color, transparent);
    &:hover {
      background: var(--color-scrollbar-thumb-hover);
    }
  }
`

Scrollbar.displayName = 'Scrollbar'

export default Scrollbar
