import type { CSSProperties } from 'react'

type Props = {
  /** Numeric capacity, or null for unlimited (∞). Numeric 100 renders as "100". */
  maxContext: number | null
  style?: CSSProperties
}

export default function MaxContextCount({ maxContext, style }: Props) {
  // LOCK-LAYOUT-1: both branches render a plain inline span with no font metrics
  // of their own, so finite and infinity inherit identical font-size, line-height,
  // display and vertical alignment from their context (no title-row height shift).
  return <span style={style}>{maxContext === null ? '∞' : maxContext.toString()}</span>
}
