import type { InputModality } from '@renderer/utils/inputModalities'
import {
  Braces,
  Brain,
  FileText,
  Image as ImageIcon,
  type LucideIcon,
  Thermometer,
  Type,
  Video,
  Volume2,
  Wrench
} from 'lucide-react'

/**
 * Shared display meta for input modalities + model features (unit 2).
 *
 * Single icon/label/color truth for:
 * - ModelTagsWithLabel (compact read-only bare icons)
 * - TagFilterSection (clickable neutral filters)
 * - ModelCapabilityGroups (detail icon+text)
 *
 * Kept in components/ (not pure utils/) so icon components can live here
 * without forcing utils/inputModalities to depend on React. Data resolution
 * stays in utils/inputModalities; this file is display-only.
 */

export const COMPACT_ICON_SIZE = 14
export const COMPACT_SLOT_SIZE = 20

export const MODALITY_ICONS: Record<InputModality, LucideIcon> = {
  text: Type,
  image: ImageIcon,
  audio: Volume2,
  video: Video,
  // PDF keeps FileText: distinct from Text (Type) without extra crowded glyphs.
  pdf: FileText
}

export const MODALITY_LABEL_KEYS: Record<InputModality, string> = {
  text: 'models.capabilities.modality_text',
  image: 'models.capabilities.modality_image',
  audio: 'models.capabilities.modality_audio',
  video: 'models.capabilities.modality_video',
  pdf: 'models.capabilities.modality_pdf'
}

/** Detail capsule colors for the Input Modalities group (five-color pills).
 *
 * Hexes only (CustomTag builds `color + '20'` for its background, so CSS vars
 * are illegal here). Mid-brightness Ant-palette values stay readable on both
 * light and dark surfaces; unsupported still renders inactive gray via
 * CustomTag `inactive`.
 * - Text: blue, Image: green, Audio: purple, Video: magenta, PDF: orange-red.
 */
export const MODALITY_DETAIL_COLORS: Record<InputModality, string> = {
  text: '#1677ff',
  image: '#00b96b',
  audio: '#722ed1',
  video: '#eb2f96',
  pdf: '#fa541c'
}

/**
 * Compact/filter border+icon colors for the five input modalities.
 * Same hue family as the detail capsules so compact rows and filter chips
 * match the Edit Model group at a glance.
 */
export const MODALITY_COMPACT_COLORS: Record<InputModality, string> = {
  text: '#1677ff',
  image: '#00b96b',
  audio: '#722ed1',
  video: '#eb2f96',
  pdf: '#fa541c'
}

/** Shared per-modality meta: icons, label keys, and both color lanes. */
export const MODALITY_META: Record<
  InputModality,
  { icon: LucideIcon; labelKey: string; detailColor: string; compactColor: string }
> = {
  text: {
    icon: Type,
    labelKey: MODALITY_LABEL_KEYS.text,
    detailColor: MODALITY_DETAIL_COLORS.text,
    compactColor: MODALITY_COMPACT_COLORS.text
  },
  image: {
    icon: ImageIcon,
    labelKey: MODALITY_LABEL_KEYS.image,
    detailColor: MODALITY_DETAIL_COLORS.image,
    compactColor: MODALITY_COMPACT_COLORS.image
  },
  audio: {
    icon: Volume2,
    labelKey: MODALITY_LABEL_KEYS.audio,
    detailColor: MODALITY_DETAIL_COLORS.audio,
    compactColor: MODALITY_COMPACT_COLORS.audio
  },
  video: {
    icon: Video,
    labelKey: MODALITY_LABEL_KEYS.video,
    detailColor: MODALITY_DETAIL_COLORS.video,
    compactColor: MODALITY_COMPACT_COLORS.video
  },
  pdf: {
    icon: FileText,
    labelKey: MODALITY_LABEL_KEYS.pdf,
    detailColor: MODALITY_DETAIL_COLORS.pdf,
    compactColor: MODALITY_COMPACT_COLORS.pdf
  }
}

export type ModelFeatureKey = 'reasoning' | 'toolCall' | 'structuredOutput' | 'temperature'

export const FEATURE_ICONS: Record<ModelFeatureKey, LucideIcon> = {
  reasoning: Brain,
  toolCall: Wrench,
  structuredOutput: Braces,
  temperature: Thermometer
}

export const FEATURE_LABEL_KEYS: Record<ModelFeatureKey, string> = {
  reasoning: 'models.capabilities.feature_reasoning',
  toolCall: 'models.capabilities.feature_tool_call',
  structuredOutput: 'models.capabilities.feature_structured_output',
  temperature: 'models.capabilities.feature_temperature'
}

/**
 * Theme-friendly feature colors, mutually distinct in both themes.
 * - Reasoning: indigo/purple
 * - Tool Call: orange
 * - Structured Output: cyan/teal
 * - Temperature: magenta/pink (never warning orange #faad14)
 * Hexes chosen with mid brightness so they stay readable on both
 * light (white) and dark (black) surfaces; unsupported still renders
 * inactive gray via CustomTag `inactive`.
 */
export const FEATURE_COLORS: Record<ModelFeatureKey, string> = {
  reasoning: '#5b6cff',
  toolCall: '#d9730d',
  structuredOutput: '#08979c',
  temperature: '#eb2f96'
}

/** Warning token that Temperature must never reuse (kept as a guard for tests). */
export const WARNING_ORANGE = '#faad14'
