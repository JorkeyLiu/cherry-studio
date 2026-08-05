/**
 * attachmentAvailability tests (LOCK-UI-1..6) — pure marker contract.
 *
 * Covers the import-only per-block unavailable marker key, the strict
 * boolean contract, the idempotent merge, and the digest-stripping helper
 * used by the shared entity framing (LOCK-UI-6).
 */

import { describe, expect, it } from 'vitest'

import {
  isBlockAttachmentUnavailable,
  L2_ATTACHMENT_UNAVAILABLE_MARKER,
  markBlockAttachmentUnavailable,
  stripBlockAttachmentUnavailableMarker
} from '../attachmentAvailability'

describe('attachmentAvailability marker contract (LOCK-UI-1..6)', () => {
  it('uses a narrow namespaced top-level overflow key (LOCK-UI-1 house style)', () => {
    expect(L2_ATTACHMENT_UNAVAILABLE_MARKER).toBe('l2AttachmentUnavailable')
  })

  it('marks a plain overflow and preserves every other key (LOCK-UI-3)', () => {
    const overflow = {
      file: { id: 'f', name: 'photo.png', path: '/abs/photo.png', type: 'image' },
      metadata: { prompt: 'keep-me' }
    }
    const marked = markBlockAttachmentUnavailable(overflow)
    // The INPUT is never mutated (LOCK-UI-3).
    expect(overflow[L2_ATTACHMENT_UNAVAILABLE_MARKER]).toBeUndefined()
    // Output: original keys preserved byte-for-byte, marker added.
    expect(marked.file).toEqual(overflow.file)
    expect(marked.metadata).toEqual({ prompt: 'keep-me' })
    expect(marked[L2_ATTACHMENT_UNAVAILABLE_MARKER]).toBe(true)
    expect(isBlockAttachmentUnavailable(marked)).toBe(true)
  })

  it('never creates a fake file/status and works on an empty overflow', () => {
    const marked = markBlockAttachmentUnavailable({})
    expect(marked).toEqual({ l2AttachmentUnavailable: true })
    expect(isBlockAttachmentUnavailable(marked)).toBe(true)
  })

  it('is idempotent and strict (LOCK-UI-6): only the exact boolean true counts', () => {
    const once = markBlockAttachmentUnavailable({})
    expect(markBlockAttachmentUnavailable(once)).toBe(once) // same reference
    expect(isBlockAttachmentUnavailable({ l2AttachmentUnavailable: false })).toBe(false)
    expect(isBlockAttachmentUnavailable({ l2AttachmentUnavailable: 'yes' })).toBe(false)
    expect(isBlockAttachmentUnavailable({ l2AttachmentUnavailable: 1 })).toBe(false)
    expect(isBlockAttachmentUnavailable({})).toBe(false)
  })

  it('strips ONLY the marker key and restores the byte-exact original overflow (LOCK-UI-6)', () => {
    const original = { file: { id: 'f' }, metadata: { prompt: 'p' }, traceId: null }
    const marked = markBlockAttachmentUnavailable(original)
    const stripped = stripBlockAttachmentUnavailableMarker(marked)
    expect(stripped).toEqual(original)
    // Marker-free overflow passes through as the SAME reference (existing
    // digests stay byte-identical).
    expect(stripBlockAttachmentUnavailableMarker(original)).toBe(original)
    // A nested unrelated key with the same name is never touched.
    const nested = { metadata: { l2AttachmentUnavailable: 'source-value' } }
    expect(stripBlockAttachmentUnavailableMarker(nested)).toBe(nested)
  })
})
