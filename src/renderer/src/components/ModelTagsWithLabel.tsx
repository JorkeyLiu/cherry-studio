import {
  COMPACT_ICON_SIZE,
  COMPACT_SLOT_SIZE,
  MODALITY_ICONS,
  MODALITY_LABEL_KEYS
} from '@renderer/components/modelMetadataDisplay'
import type { Model, Provider } from '@renderer/types'
import { getSupportedInputModalitiesForDisplay } from '@renderer/utils/inputModalities'
import type { FC } from 'react'
import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface ModelTagsProps {
  model: Model
  /**
   * Exact owning provider when the caller already has it (provider lists,
   * manage lists, mention panels). When omitted, attribution falls back to
   * `strictProviderForModel` (exact match only, never name guessing); no
   * exact entry match renders zero tags.
   */
  provider?: Provider | null
  size?: number
  showTooltip?: boolean
  style?: React.CSSProperties
}

/**
 * Compact model capability tags: precise `modalities.input` from the
 * effective display metadata only (`getSupportedInputModalitiesForDisplay` →
 * serving wins, canonical fills gaps, unknown → empty). Renders one neutral
 * outline box per explicitly supported Text/Image/Audio/Video/PDF value;
 * unknown entries and unsupported values render nothing, and Model Features /
 * Free are never shown here. All consumers (provider ModelList,
 * ManageModelsList, SelectModelPopup, @mention) share this component, so
 * they stay consistent automatically. Shares the same effective resolver
 * as the detail groups (ModelCapabilityGroups via ModelEditContent), so
 * list and detail never diverge.
 *
 * Visual contract: no CustomTag, no pill, no filled background, no text,
 * no per-modality color. Each icon lives in a fixed 20px transparent
 * square (4px radius, 1px neutral border) with a 14px neutral lucide glyph.
 * Hover brightens border/icon slightly but stays transparent and neutral.
 * Every slot carries a single native `title` plus a matching `aria-label`;
 * the svg is aria-hidden.
 */
const ModelTagsWithLabel: FC<ModelTagsProps> = ({ model, provider, showTooltip = true, style }) => {
  const { t } = useTranslation()

  const modalities = useMemo(
    () => getSupportedInputModalitiesForDisplay(model, provider),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- model identity is the unit; provider id pins attribution
    [model?.id, model?.provider, provider?.id]
  )

  const labels = useMemo(
    () => ({
      text: t(MODALITY_LABEL_KEYS.text),
      image: t(MODALITY_LABEL_KEYS.image),
      audio: t(MODALITY_LABEL_KEYS.audio),
      video: t(MODALITY_LABEL_KEYS.video),
      pdf: t(MODALITY_LABEL_KEYS.pdf)
    }),
    [t]
  )

  void showTooltip

  return (
    <Container style={style}>
      {modalities.map((modality) => {
        const Icon = MODALITY_ICONS[modality]
        const label = labels[modality]
        return (
          <IconSlot key={modality} data-testid={`modality-tag-${modality}`} title={label} aria-label={label}>
            <Icon size={COMPACT_ICON_SIZE} strokeWidth={2} aria-hidden />
          </IconSlot>
        )
      })}
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  flex-wrap: nowrap;
  overflow: hidden;
`

const IconSlot = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: ${COMPACT_SLOT_SIZE}px;
  height: ${COMPACT_SLOT_SIZE}px;
  flex: none;
  border-radius: 4px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-2);
  &:hover {
    color: var(--color-text-1);
    border-color: var(--color-text-3);
  }
`

export default memo(ModelTagsWithLabel)
