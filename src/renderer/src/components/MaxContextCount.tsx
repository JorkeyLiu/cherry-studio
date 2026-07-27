import type { CSSProperties } from 'react'

type Props = {
  /** Numeric capacity, or null for unlimited (∞). Numeric 100 renders as "100". */
  maxContext: number | null
  style?: CSSProperties
}

export default function MaxContextCount({ maxContext, style }: Props) {
  return maxContext === null ? (
    <span style={{ fontSize: '16px', ...style }}>∞</span>
  ) : (
    <span style={style}>{maxContext.toString()}</span>
  )
}
