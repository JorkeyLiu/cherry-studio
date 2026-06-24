import { MAX_CONTEXT_COUNT } from '@renderer/config/constant'
import type { CSSProperties } from 'react'

type Props = {
  maxContext: number
  style?: CSSProperties
}

export default function MaxContextCount({ maxContext, style }: Props) {
  return maxContext === MAX_CONTEXT_COUNT ? (
    <span style={{ fontSize: '16px', ...style }}>∞</span>
  ) : (
    <span style={style}>{maxContext.toString()}</span>
  )
}
