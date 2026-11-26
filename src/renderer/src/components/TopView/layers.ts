/**
 * Layer-state seam for the TopView stack.
 *
 * Kept dependency-free (no React, no antd, no app services) on purpose: a
 * dialog that only needs to know whether a TopView child is layered above it —
 * and to close the topmost one — can import this module without pulling the
 * container's provider wiring (i18n, app init, dexie) into its own module graph.
 *
 * The container publishes the open count on every stack mutation and registers
 * the "close the topmost" operation while it is mounted. Both entries are read
 * lazily through this module, so they never freeze a stale closure.
 */
let openCount = 0
let popHandler: () => void = () => {}

type CountListener = (count: number) => void
const listeners = new Set<CountListener>()

/** Container-side: publish the current open-element count. */
export const reportTopViewLayerCount = (count: number) => {
  if (count === openCount) return
  openCount = count
  listeners.forEach((listener) => listener(count))
}

/** Container-side: register the operation that closes the topmost element. */
export const registerTopViewPopHandler = (handler: () => void) => {
  popHandler = handler
}

/** Number of elements currently layered in the TopView stack. */
export const getTopViewLayerCount = () => openCount

/** Close the topmost layered element (no-op when the stack is empty). */
export const popTopViewLayer = () => popHandler()

/** Subscribe to layer-count changes; fires immediately with the current count. */
export const subscribeTopViewLayerCount = (listener: CountListener) => {
  listeners.add(listener)
  listener(openCount)
  return () => {
    listeners.delete(listener)
  }
}
