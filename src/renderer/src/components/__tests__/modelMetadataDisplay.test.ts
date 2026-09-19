import {
  FEATURE_COLORS,
  FEATURE_ICONS,
  MODALITY_COMPACT_COLORS,
  MODALITY_DETAIL_COLORS,
  MODALITY_ICONS,
  MODALITY_META,
  WARNING_ORANGE
} from '@renderer/components/modelMetadataDisplay'
import { describe, expect, it } from 'vitest'

const HEX = /^#[0-9a-f]{6}$/i

describe('modelMetadataDisplay (shared unit-2 truth)', () => {
  it('covers all five modalities with icons and five-color detail/compact hues', () => {
    expect(Object.keys(MODALITY_ICONS).sort()).toEqual(['audio', 'image', 'pdf', 'text', 'video'])
    for (const Icon of Object.values(MODALITY_ICONS)) {
      expect(Icon).toBeDefined()
    }
    // Five detail capsules + five compact hues, hex only (CustomTag builds
    // `color + '20'`, so CSS vars are illegal).
    expect(Object.keys(MODALITY_DETAIL_COLORS).sort()).toEqual(['audio', 'image', 'pdf', 'text', 'video'])
    expect(Object.keys(MODALITY_COMPACT_COLORS).sort()).toEqual(['audio', 'image', 'pdf', 'text', 'video'])
    for (const color of [...Object.values(MODALITY_DETAIL_COLORS), ...Object.values(MODALITY_COMPACT_COLORS)]) {
      expect(color).toMatch(HEX)
      expect(color).not.toContain('var(')
    }
    // Detail and compact share the same hue family per modality.
    for (const modality of ['text', 'image', 'audio', 'video', 'pdf'] as const) {
      expect(MODALITY_COMPACT_COLORS[modality].toLowerCase()).toBe(MODALITY_DETAIL_COLORS[modality].toLowerCase())
      expect(MODALITY_META[modality].detailColor).toBe(MODALITY_DETAIL_COLORS[modality])
      expect(MODALITY_META[modality].compactColor).toBe(MODALITY_COMPACT_COLORS[modality])
    }
    // Five detail colors stay mutually distinct.
    expect(new Set(Object.values(MODALITY_DETAIL_COLORS).map((c) => c.toLowerCase())).size).toBe(5)
  })

  it('keeps four feature colors mutually distinct with temperature off warning orange', () => {
    const colors = Object.values(FEATURE_COLORS)
    expect(new Set(colors.map((c) => c.toLowerCase())).size).toBe(4)
    expect(FEATURE_COLORS.temperature.toLowerCase()).not.toBe(WARNING_ORANGE.toLowerCase())
    expect(FEATURE_COLORS.temperature.toLowerCase()).not.toBe('#faad14')
    expect(FEATURE_COLORS.toolCall.toLowerCase()).not.toBe(FEATURE_COLORS.temperature.toLowerCase())
    for (const Icon of Object.values(FEATURE_ICONS)) {
      expect(Icon).toBeDefined()
    }
  })
})
