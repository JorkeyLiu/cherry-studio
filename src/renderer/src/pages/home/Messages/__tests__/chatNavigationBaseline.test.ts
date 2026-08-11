/**
 * Tests for resolveVisibleBaseline — the DOM-based baseline resolver used by
 * ChatNavigation to determine which user message ID to pass to the full-sequence
 * navigation callbacks (previousUserMessage / nextUserMessage).
 *
 * DOM contract tested here:
 *   - `.message-user[data-message-id]` — user message container
 *   - `.message-assistant[data-ask-id]` — assistant message container
 *   - `data-ask-id` on assistant = the triggering user message ID
 *
 * These tests build mock DOM trees with controlled bounding rects so they
 * exercise the pure helper without real layout computation.
 */
import { describe, expect, it } from 'vitest'

import { resolveVisibleBaseline } from '../ChatNavigation'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal DOMRect with only the fields the helper reads. */
const rect = (top: number, bottom: number): DOMRect => {
  const height = bottom - top
  return {
    top,
    bottom,
    height,
    left: 0,
    right: 100,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({})
  }
}

interface ChildSpec {
  className: string
  childRect: DOMRect
  dataset?: Record<string, string>
}

/**
 * Creates a mock scroll container with children whose getBoundingClientRect
 * returns controlled rects. The container itself is 0..1000 (height 1000).
 * The helper's visible threshold is 10% of container height = 100px.
 */
const buildContainer = (children: ChildSpec[]): HTMLElement => {
  const container = document.createElement('div')
  Object.defineProperty(container, 'getBoundingClientRect', {
    value: () => rect(0, 1000),
    configurable: true
  })

  for (const spec of children) {
    const el = document.createElement('div')
    el.className = spec.className
    if (spec.dataset) {
      for (const [k, v] of Object.entries(spec.dataset)) {
        el.dataset[k] = v
      }
    }
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => spec.childRect,
      configurable: true
    })
    container.appendChild(el)
  }

  return container
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveVisibleBaseline', () => {
  // Container rect: 0..1000, threshold = 100px (10%)

  // -----------------------------------------------------------------------
  // 1. User message direct baseline
  // -----------------------------------------------------------------------
  describe('user message as direct baseline', () => {
    it('returns data-message-id of a visible user message', () => {
      const container = buildContainer([
        { className: 'message-user', childRect: rect(50, 300), dataset: { messageId: 'u1' } }
      ])
      expect(resolveVisibleBaseline(container, 'up')).toBe('u1')
      expect(resolveVisibleBaseline(container, 'down')).toBe('u1')
    })

    it('direction "up" selects bottommost visible user, "down" selects topmost', () => {
      const container = buildContainer([
        { className: 'message-user', childRect: rect(20, 200), dataset: { messageId: 'u-top' } },
        { className: 'message-user', childRect: rect(700, 900), dataset: { messageId: 'u-bottom' } }
      ])
      // 'up' → bottommost visible (for prev navigation, current pos)
      expect(resolveVisibleBaseline(container, 'up')).toBe('u-bottom')
      // 'down' → topmost visible (for next navigation, current pos)
      expect(resolveVisibleBaseline(container, 'down')).toBe('u-top')
    })

    it('ignores user messages with insufficient visibility (< 10% threshold)', () => {
      // Element is 100px tall, only 5px visible — below the 100px threshold
      const container = buildContainer([
        { className: 'message-user', childRect: rect(-95, 5), dataset: { messageId: 'u-barely' } }
      ])
      expect(resolveVisibleBaseline(container, 'up')).toBeNull()
      expect(resolveVisibleBaseline(container, 'down')).toBeNull()
    })

    it('accepts user message with exactly 10% visibility (at threshold)', () => {
      // Element 200px tall, 100px visible = exactly at threshold
      const container = buildContainer([
        { className: 'message-user', childRect: rect(-100, 0), dataset: { messageId: 'u-edge' } }
      ])
      // visibleHeight = min(0, 1000) - max(-100, 0) = 0 - 0 = 0 → NOT visible
      // The element's bottom is exactly at container's top — visible height is 0
      expect(resolveVisibleBaseline(container, 'up')).toBeNull()
    })

    it('accepts user message with visible height >= min(elementHeight, threshold)', () => {
      // Element 50px tall (small), 30px visible. min(50, 100) = 50. 30 < 50 → not visible
      const container = buildContainer([
        { className: 'message-user', childRect: rect(-20, 30), dataset: { messageId: 'u-small' } }
      ])
      expect(resolveVisibleBaseline(container, 'up')).toBeNull()

      // Element 50px tall, 50px visible. min(50, 100) = 50. 50 >= 50 → visible
      const container2 = buildContainer([
        { className: 'message-user', childRect: rect(0, 50), dataset: { messageId: 'u-small2' } }
      ])
      expect(resolveVisibleBaseline(container2, 'up')).toBe('u-small2')
    })
  })

  // -----------------------------------------------------------------------
  // 2. Assistant askId as baseline (no visible user messages)
  // -----------------------------------------------------------------------
  describe('assistant askId as baseline', () => {
    it('returns askId of visible assistant when no user message is visible', () => {
      const container = buildContainer([
        {
          className: 'message-assistant',
          childRect: rect(100, 400),
          dataset: { messageId: 'a1', askId: 'u1' }
        }
      ])
      expect(resolveVisibleBaseline(container, 'up')).toBe('u1')
      expect(resolveVisibleBaseline(container, 'down')).toBe('u1')
    })

    it('direction "up" selects bottommost visible assistant, "down" selects topmost', () => {
      const container = buildContainer([
        {
          className: 'message-assistant',
          childRect: rect(50, 200),
          dataset: { messageId: 'a-top', askId: 'u1' }
        },
        {
          className: 'message-assistant',
          childRect: rect(700, 900),
          dataset: { messageId: 'a-bottom', askId: 'u2' }
        }
      ])
      expect(resolveVisibleBaseline(container, 'up')).toBe('u2')
      expect(resolveVisibleBaseline(container, 'down')).toBe('u1')
    })

    it('ignores assistants without data-ask-id attribute', () => {
      const container = buildContainer([
        {
          className: 'message-assistant',
          childRect: rect(100, 400),
          dataset: { messageId: 'a1' } // no askId
        }
      ])
      expect(resolveVisibleBaseline(container, 'up')).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // 3. Multi-model: same askId → same baseline
  // -----------------------------------------------------------------------
  describe('multi-model assistant resolution', () => {
    it('all assistants with the same askId resolve to the same user baseline', () => {
      const container = buildContainer([
        {
          className: 'message-assistant',
          childRect: rect(20, 180),
          dataset: { messageId: 'a1', askId: 'u1' }
        },
        {
          className: 'message-assistant',
          childRect: rect(190, 350),
          dataset: { messageId: 'a2', askId: 'u1' }
        },
        {
          className: 'message-assistant',
          childRect: rect(360, 520),
          dataset: { messageId: 'a3', askId: 'u1' }
        }
      ])
      expect(resolveVisibleBaseline(container, 'up')).toBe('u1')
      expect(resolveVisibleBaseline(container, 'down')).toBe('u1')
    })

    it('different askId groups use direction to select baseline', () => {
      // Group1: a1, a2 with askId u1 (visible at top)
      // Group2: a3 with askId u2 (visible at bottom)
      const container = buildContainer([
        {
          className: 'message-assistant',
          childRect: rect(20, 180),
          dataset: { messageId: 'a1', askId: 'u1' }
        },
        {
          className: 'message-assistant',
          childRect: rect(190, 350),
          dataset: { messageId: 'a2', askId: 'u1' }
        },
        {
          className: 'message-assistant',
          childRect: rect(600, 800),
          dataset: { messageId: 'a3', askId: 'u2' }
        }
      ])
      // 'up' → bottommost assistant (a3) → askId u2
      expect(resolveVisibleBaseline(container, 'up')).toBe('u2')
      // 'down' → topmost assistant (a1) → askId u1
      expect(resolveVisibleBaseline(container, 'down')).toBe('u1')
    })

    it('unequal assistant and user counts do not cause index-based mis-mapping', () => {
      // 1 user, 3 assistants (multi-model) — all assistants map to same user via askId
      const container = buildContainer([
        {
          className: 'message-assistant',
          childRect: rect(20, 180),
          dataset: { messageId: 'a1', askId: 'u1' }
        },
        {
          className: 'message-assistant',
          childRect: rect(190, 350),
          dataset: { messageId: 'a2', askId: 'u1' }
        },
        {
          className: 'message-assistant',
          childRect: rect(360, 520),
          dataset: { messageId: 'a3', askId: 'u1' }
        }
      ])
      // All resolve to u1, NOT to some phantom user[2] or user[assistantIndex]
      expect(resolveVisibleBaseline(container, 'up')).toBe('u1')
      expect(resolveVisibleBaseline(container, 'down')).toBe('u1')
    })
  })

  // -----------------------------------------------------------------------
  // 4. User takes priority over assistant
  // -----------------------------------------------------------------------
  describe('user priority over assistant', () => {
    it('when both user and assistant are visible, user message wins', () => {
      const container = buildContainer([
        {
          className: 'message-assistant',
          childRect: rect(100, 300),
          dataset: { messageId: 'a1', askId: 'u-other' }
        },
        {
          className: 'message-user',
          childRect: rect(50, 150),
          dataset: { messageId: 'u1' }
        }
      ])
      expect(resolveVisibleBaseline(container, 'up')).toBe('u1')
      expect(resolveVisibleBaseline(container, 'down')).toBe('u1')
    })
  })

  // -----------------------------------------------------------------------
  // 5. No visible baseline → null (no top/bottom jump)
  // -----------------------------------------------------------------------
  describe('no baseline visible → returns null', () => {
    it('returns null for empty container', () => {
      const container = buildContainer([])
      expect(resolveVisibleBaseline(container, 'up')).toBeNull()
      expect(resolveVisibleBaseline(container, 'down')).toBeNull()
    })

    it('returns null when all elements are above viewport', () => {
      const container = buildContainer([
        { className: 'message-user', childRect: rect(-500, -300), dataset: { messageId: 'u1' } }
      ])
      expect(resolveVisibleBaseline(container, 'up')).toBeNull()
    })

    it('returns null when all elements are below viewport', () => {
      const container = buildContainer([
        {
          className: 'message-assistant',
          childRect: rect(1100, 1300),
          dataset: { messageId: 'a1', askId: 'u1' }
        }
      ])
      expect(resolveVisibleBaseline(container, 'down')).toBeNull()
    })

    it('returns null when only non-message elements are visible', () => {
      const container = buildContainer([
        { className: 'other-class', childRect: rect(100, 300), dataset: { messageId: 'x1' } }
      ])
      expect(resolveVisibleBaseline(container, 'up')).toBeNull()
    })

    it('returns null when user elements exist but lack data-message-id', () => {
      const container = buildContainer([
        { className: 'message-user', childRect: rect(100, 300) } // no dataset
      ])
      expect(resolveVisibleBaseline(container, 'up')).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // 6. Mixed topic scenarios
  // -----------------------------------------------------------------------
  describe('realistic topic with alternating user/assistant messages', () => {
    /**
     * Simulates: u1 → [a1, a2](askId=u1) → u2 → [a3](askId=u2)
     * Only u2 and group1 are visible.
     */
    it('visible assistant group at top and user at bottom — direction resolves correctly', () => {
      const container = buildContainer([
        {
          className: 'message-assistant',
          childRect: rect(50, 200),
          dataset: { messageId: 'a1', askId: 'u1' }
        },
        {
          className: 'message-assistant',
          childRect: rect(210, 360),
          dataset: { messageId: 'a2', askId: 'u1' }
        },
        {
          className: 'message-user',
          childRect: rect(380, 500),
          dataset: { messageId: 'u2' }
        }
      ])
      // User is visible → user takes priority
      // 'up' → bottommost user → u2
      expect(resolveVisibleBaseline(container, 'up')).toBe('u2')
      // 'down' → topmost user → u2 (only one visible user)
      expect(resolveVisibleBaseline(container, 'down')).toBe('u2')
    })

    it('only assistant group visible — askId used as baseline', () => {
      const container = buildContainer([
        {
          className: 'message-assistant',
          childRect: rect(100, 300),
          dataset: { messageId: 'a1', askId: 'u1' }
        },
        {
          className: 'message-assistant',
          childRect: rect(310, 500),
          dataset: { messageId: 'a2', askId: 'u1' }
        },
        {
          className: 'message-assistant',
          childRect: rect(510, 700),
          dataset: { messageId: 'a3', askId: 'u1' }
        }
      ])
      // All three assistants have askId u1
      expect(resolveVisibleBaseline(container, 'up')).toBe('u1')
      expect(resolveVisibleBaseline(container, 'down')).toBe('u1')
    })

    /**
     * Simulates: u1 → [a1](askId=u1) → u2 → [a2, a3](askId=u2) → u3
     * a1 group visible at top, u2 visible at middle, a2/a3 group at bottom
     */
    it('multiple groups visible across viewport — user priority', () => {
      const container = buildContainer([
        {
          className: 'message-assistant',
          childRect: rect(20, 180),
          dataset: { messageId: 'a1', askId: 'u1' }
        },
        {
          className: 'message-user',
          childRect: rect(200, 350),
          dataset: { messageId: 'u2' }
        },
        {
          className: 'message-assistant',
          childRect: rect(370, 520),
          dataset: { messageId: 'a2', askId: 'u2' }
        },
        {
          className: 'message-assistant',
          childRect: rect(530, 680),
          dataset: { messageId: 'a3', askId: 'u2' }
        },
        {
          className: 'message-user',
          childRect: rect(700, 850),
          dataset: { messageId: 'u3' }
        }
      ])
      // Two visible users: u2 and u3
      // 'up' → bottommost user → u3
      expect(resolveVisibleBaseline(container, 'up')).toBe('u3')
      // 'down' → topmost user → u2
      expect(resolveVisibleBaseline(container, 'down')).toBe('u2')
    })
  })
})
