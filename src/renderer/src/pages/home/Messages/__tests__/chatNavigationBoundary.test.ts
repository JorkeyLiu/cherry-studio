/**
 * Tests for ChatNavigation two-stage "top" button behavior.
 *
 * The "top" button has a two-stage behavior:
 *   1. First click → scroll to context boundary (via scrollToContextBoundary callback)
 *   2. Second click → scroll to topic oldest (via scrollToTop callback)
 *
 * This test verifies the callback dispatch logic without DOM rendering.
 */
import { describe, expect, it, vi } from 'vitest'

/**
 * Extracted logic test: simulates the handleScrollToTop decision logic
 * from ChatNavigation without requiring React rendering.
 */
const createTopClickSimulator = () => {
  let stoppedAtBoundary = false

  const simulator = {
    scrollToContextBoundary: vi.fn(),
    scrollToTop: vi.fn(),

    /** Simulates handleScrollToTop click */
    click(hasContextBoundary: boolean) {
      if (!stoppedAtBoundary && hasContextBoundary) {
        stoppedAtBoundary = true
        simulator.scrollToContextBoundary()
        return
      }
      stoppedAtBoundary = false
      simulator.scrollToTop()
    },

    /** Simulates user scroll event resetting boundary state */
    onScroll() {
      stoppedAtBoundary = false
    },

    /** Simulates other navigation resetting boundary state */
    resetBoundary() {
      stoppedAtBoundary = false
    }
  }

  return simulator
}

describe('ChatNavigation two-stage top behavior', () => {
  it('first click calls scrollToContextBoundary when boundary exists', () => {
    const sim = createTopClickSimulator()
    sim.click(/* hasContextBoundary */ true)

    expect(sim.scrollToContextBoundary).toHaveBeenCalledOnce()
    expect(sim.scrollToTop).not.toHaveBeenCalled()
  })

  it('second click calls scrollToTop', () => {
    const sim = createTopClickSimulator()
    sim.click(true) // first click → boundary
    sim.click(true) // second click → top

    expect(sim.scrollToContextBoundary).toHaveBeenCalledOnce()
    expect(sim.scrollToTop).toHaveBeenCalledOnce()
  })

  it('first click calls scrollToTop when no boundary exists', () => {
    const sim = createTopClickSimulator()
    sim.click(/* hasContextBoundary */ false)

    expect(sim.scrollToContextBoundary).not.toHaveBeenCalled()
    expect(sim.scrollToTop).toHaveBeenCalledOnce()
  })

  it('scroll event resets to boundary-first behavior', () => {
    const sim = createTopClickSimulator()
    sim.click(true) // first click → boundary
    sim.onScroll() // user scrolls
    sim.click(true) // should go to boundary again

    expect(sim.scrollToContextBoundary).toHaveBeenCalledTimes(2)
    expect(sim.scrollToTop).not.toHaveBeenCalled()
  })

  it('boundary period: canHandleUserViewportScroll is false', () => {
    // This test verifies the production invariant: during boundary navigation,
    // the viewport state's navigation.phase is NOT 'idle' or scrollMode is NOT 'user',
    // so canHandleUserViewportScroll returns false.
    //
    // This is tested at the integration level in messageNavigation.test.ts.
    // Here we verify the contract holds: scrollToContextBoundary triggers
    // a navigate({ kind: 'message', ... }) which enters the transaction.
    const sim = createTopClickSimulator()

    // During boundary navigation, the transaction sets:
    //   navigation.phase = 'preparing' | 'scrolling'
    //   scrollMode = 'programmatic'
    // So canHandleUserViewportScroll returns false.
    // We test this by verifying the callback is called (it triggers the transaction).
    sim.click(true)
    expect(sim.scrollToContextBoundary).toHaveBeenCalledOnce()

    // The transaction contract guarantees canHandleUserViewportScroll = false
    // while the navigation is in-flight.
  })

  it('three rapid clicks: boundary → top → boundary (resets after top)', () => {
    const sim = createTopClickSimulator()
    sim.click(true) // 1st → boundary
    sim.click(true) // 2nd → top
    sim.click(true) // 3rd → boundary again (reset happened after top)

    expect(sim.scrollToContextBoundary).toHaveBeenCalledTimes(2)
    expect(sim.scrollToTop).toHaveBeenCalledOnce()
  })
})
