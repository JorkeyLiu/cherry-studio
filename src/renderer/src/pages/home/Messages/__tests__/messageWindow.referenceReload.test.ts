/**
 * Focused regression for the resident reference-reload obligation.
 *
 * A Main→renderer history-reference invalidation must make the already-open
 * reference target re-read Main. The controller's DOM provenance is mutable
 * state that an ordinary projection apply can re-stamp clean
 * (`noteSameRouteWindowUpdate` / `rebaseClean`) between the hint and the
 * passive route effect, so a provenance-only signal can be undone and the
 * effect would idle-skip — leaving a soft-deleted source displayed as
 * `available` with its foreign prefix until the next activation.
 *
 * These cases pin the pure decision (monotonic, topic-bound, one-shot) and the
 * production wiring that consumes it exactly where the re-read pipeline takes
 * ownership.
 */
import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { isReferenceReloadObliged } from '../messageWindow'

const messagesSource = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')

describe('isReferenceReloadObliged (resident reference re-read obligation)', () => {
  it('is false with no pending obligation', () => {
    expect(isReferenceReloadObliged(null, 0, 'topic-a')).toBe(false)
  })

  it('is false when the pending obligation belongs to another topic', () => {
    expect(isReferenceReloadObliged({ token: 1, topicId: 'topic-b' }, 0, 'topic-a')).toBe(false)
  })

  it('is true for an unconsumed obligation on the requested topic', () => {
    expect(isReferenceReloadObliged({ token: 1, topicId: 'topic-a' }, 0, 'topic-a')).toBe(true)
  })

  it('is false once that exact token was consumed', () => {
    expect(isReferenceReloadObliged({ token: 1, topicId: 'topic-a' }, 1, 'topic-a')).toBe(false)
  })

  it('keeps a newer obligation alive across an older consume (monotonic, never lost)', () => {
    // Hints arrive in bursts: consuming token 2 must never swallow token 3.
    expect(isReferenceReloadObliged({ token: 3, topicId: 'topic-a' }, 2, 'topic-a')).toBe(true)
  })

  it('fails closed on a non-finite token', () => {
    expect(isReferenceReloadObliged({ token: Number.NaN, topicId: 'topic-a' }, 0, 'topic-a')).toBe(false)
  })
})

describe('Messages route effect honors the reference-reload obligation', () => {
  it('both idle-skip guards require "provenance clean AND no pending obligation"', () => {
    // Loaded-current skip (terminal/idle resident route).
    expect(messagesSource).toMatch(/if \(controller\.isDomProvenanceClean && !referenceReloadObliged\) return/)
    // Displayed-stable skip (the normal steady-state early return).
    expect(messagesSource).toMatch(/controller\.isDomProvenanceClean &&\s*\n\s*!referenceReloadObliged/)
  })

  it('a pending obligation declines the in-place activation restore (Main must be re-read)', () => {
    expect(messagesSource).toMatch(/if \(wasActivation && !referenceReloadObliged\)/)
  })

  it('the re-read pipeline consumes the obligation (one-shot, no reload loop)', () => {
    expect(messagesSource).toMatch(
      /routeFetchEpochRef\.current = fetchEpoch[\s\S]{0,400}?consumedReferenceTokenRef\.current = referenceReloadRef\.current\?\.token/
    )
  })

  it('the invalidation hint raises the obligation for the resident topic', () => {
    expect(messagesSource).toMatch(
      /referenceReloadRef\.current = \{\s*token: \(referenceReloadRef\.current\?\.token \?\? 0\) \+ 1,\s*topicId: activeTopicId\s*\}/
    )
  })
})
