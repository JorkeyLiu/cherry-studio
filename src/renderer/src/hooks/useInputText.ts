import { useCallback, useRef, useState } from 'react'

export interface UseInputTextOptions {
  initialValue?: string
  onChange?: (text: string) => void
}

export interface UseInputTextReturn {
  text: string
  setText: (text: string | ((prev: string) => string)) => void
  prevText: string
  isEmpty: boolean
  clear: () => void
  // Monotonic revision of this text draft. Bumped synchronously on every
  // setText call, so ABA edits (change away and back to equal text) still
  // differ. Lets a sender capture the revision before an await and consume
  // the draft afterwards only when nothing changed meanwhile.
  getRevision: () => number
}

// Text-input state hook with history tracking.
// Provides text state management plus a synchronous monotonic revision used
// to guard draft consumption across awaits (ABA-safe: equal text after an
// intermediate edit still differs in revision).
// options.initialValue: initial text value.
// options.onChange: text change callback.
export function useInputText(options: UseInputTextOptions = {}): UseInputTextReturn {
  const [text, setText] = useState(options.initialValue ?? '')
  const prevTextRef = useRef(text)
  // Synchronous draft revision, independent of render timing.
  const revisionRef = useRef(0)
  const getRevision = useCallback(() => revisionRef.current, [])
  const handleSetText = useCallback(
    (value: string | ((prev: string) => string)) => {
      revisionRef.current += 1
      const newText = typeof value === 'function' ? value(text) : value
      prevTextRef.current = text
      setText(newText)
      options.onChange?.(newText)
    },
    [text, options]
  )

  const clear = useCallback(() => {
    handleSetText('')
  }, [handleSetText])

  return {
    text,
    setText: handleSetText,
    prevText: prevTextRef.current,
    isEmpty: text.trim().length === 0,
    clear,
    getRevision
  }
}
