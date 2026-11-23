import type { ReactNode } from 'react'
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface PairedReadingMinState {
  /** Max active pair minimum (Lm+Bm+GAP) across mounted group-first rows, 0 when none. */
  pairedMinPair: number
  reportPairedMin: (groupId: string, minPair: number | null) => void
  /**
   * Live renderer window width. The sidebar drag clamp is a fixed-window budget
   * (window - chrome - sidebars - reading floor), so it must follow the real
   * window rather than a render-time snapshot: a stale snapshot would let a
   * widened panel squeeze the chat floor after the window shrank.
   */
  windowWidth: number
}

const PairedReadingMinContext = createContext<PairedReadingMinState | null>(null)

const readWindowWidth = () => (typeof window === 'undefined' ? 0 : window.innerWidth)

export function PairedReadingMinProvider({ children }: { children: ReactNode }) {
  const minsRef = useRef<Map<string, number>>(new Map())
  const [pairedMinPair, setPairedMinPair] = useState(0)
  const [windowWidth, setWindowWidth] = useState(readWindowWidth)

  useEffect(() => {
    const syncWindowWidth = () => setWindowWidth(readWindowWidth())
    syncWindowWidth()
    window.addEventListener('resize', syncWindowWidth)
    return () => window.removeEventListener('resize', syncWindowWidth)
  }, [])

  const reportPairedMin = useCallback((groupId: string, minPair: number | null) => {
    if (minPair == null || !Number.isFinite(minPair) || minPair <= 0) {
      if (minsRef.current.has(groupId)) {
        minsRef.current.delete(groupId)
        let next = 0
        for (const v of minsRef.current.values()) next = Math.max(next, v)
        setPairedMinPair((prev) => (prev === next ? prev : next))
      }
      return
    }
    const prev = minsRef.current.get(groupId)
    if (prev === minPair) return
    minsRef.current.set(groupId, minPair)
    let next = 0
    for (const v of minsRef.current.values()) next = Math.max(next, v)
    setPairedMinPair((prevMax) => (prevMax === next ? prevMax : next))
  }, [])

  const value = useMemo(
    () => ({ pairedMinPair, reportPairedMin, windowWidth }),
    [pairedMinPair, reportPairedMin, windowWidth]
  )
  return <PairedReadingMinContext value={value}>{children}</PairedReadingMinContext>
}

export const usePairedReadingMin = (): PairedReadingMinState =>
  use(PairedReadingMinContext) ?? { pairedMinPair: 0, reportPairedMin: () => {}, windowWidth: readWindowWidth() }
