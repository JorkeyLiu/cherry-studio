import { loggerService } from '@logger'
import { MODALITY_COMPACT_COLORS, MODALITY_ICONS, MODALITY_LABEL_KEYS } from '@renderer/components/modelMetadataDisplay'
import type { InputModalityFilter } from '@renderer/utils/inputModalities'
import { INPUT_MODALITIES } from '@renderer/utils/inputModalities'
import { Flex } from 'antd'
import React, { startTransition, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const logger = loggerService.withContext('TagFilterSection')

interface TagFilterSectionProps {
  availableTags: InputModalityFilter[]
  tagSelection: Record<InputModalityFilter, boolean>
  onToggleTag: (tag: InputModalityFilter) => void
}

/**
 * Five input-modality filter chips (Text/Image/Audio/Video/PDF).
 * Unknown modalities never appear here: availability comes from exact
 * models.dev `modalities.input` support only.
 *
 * Visual contract: clickable square controls (never pills). Unselected uses
 * neutral text-3/border tokens on transparency; selected uses the modality's
 * shared compact hue for border/icon/text over a very light tint of the same
 * hue. Compact read-only rows (ModelTagsWithLabel) are untouched by this
 * control.
 */
const TagFilterSection: React.FC<TagFilterSectionProps> = ({ availableTags, tagSelection, onToggleTag }) => {
  const { t } = useTranslation()

  const handleTagClick = useCallback(
    (tag: InputModalityFilter) => {
      startTransition(() => onToggleTag(tag))
    },
    [onToggleTag]
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

  const orderedTags = useMemo(() => INPUT_MODALITIES.filter((tag) => availableTags.includes(tag)), [availableTags])

  return (
    <FilterContainer>
      <Flex wrap="wrap" gap={4} align="center">
        <FilterText>{t('models.filter.by_tag')}</FilterText>
        {orderedTags.map((tag) => {
          const Icon = MODALITY_ICONS[tag]
          const label = labels[tag]
          if (!Icon || !label) {
            logger.error(`Tag element not found for tag: ${tag}`)
            return null
          }
          const selected = Boolean(tagSelection[tag])
          return (
            <FilterChip
              key={`tag-${tag}`}
              type="button"
              data-testid={`filter-tag-${tag}`}
              aria-pressed={selected}
              data-selected={String(selected)}
              title={label}
              $color={MODALITY_COMPACT_COLORS[tag]}
              onClick={() => handleTagClick(tag)}>
              <Icon size={12} strokeWidth={2} aria-hidden />
              <span>{label}</span>
            </FilterChip>
          )
        })}
      </Flex>
    </FilterContainer>
  )
}

const FilterContainer = styled.div`
  padding: 8px;
  padding-left: 18px;
`

const FilterText = styled.span`
  color: var(--color-text-3);
  font-size: 12px;
`

const FilterChip = styled.button<{ $color: string; 'data-selected'?: string }>`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: transparent;
  cursor: pointer;
  transition:
    color 0.15s ease,
    border-color 0.15s ease,
    background-color 0.15s ease;

  &[data-selected='false'] {
    color: var(--color-text-3);
    border-color: var(--color-border);
    background: transparent;
    &:hover {
      color: var(--color-text-2);
      border-color: var(--color-text-3);
    }
  }

  &[data-selected='true'] {
    color: ${(props) => props.$color};
    border-color: ${(props) => props.$color};
    background: color-mix(in srgb, ${(props) => props.$color} 10%, transparent);
    &:hover {
      color: ${(props) => props.$color};
      border-color: ${(props) => props.$color};
      filter: brightness(1.1);
    }
  }
`

export default TagFilterSection
