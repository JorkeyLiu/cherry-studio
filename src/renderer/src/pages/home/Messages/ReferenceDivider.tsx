import type { HistoryReferenceMeta } from '@shared/chatDb'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { BoundaryLabel, BoundaryPill, BoundaryPillButton, BoundaryRow, BoundaryRule } from './BoundaryPill'

/**
 * Cross-topic history-reference divider.
 *
 * Marks the boundary between the read-only foreign prefix and the target-owned
 * writable suffix. The available form shows the LIVE source topic name as a
 * link that navigates to the captured source topic + branch + exact anchor
 * message; the missing form (source/branch/anchor gone) shows the missing
 * label while the target topic and its own suffix survive.
 *
 * Presentation is the weak-boundary pill shared with the fork divider
 * (`BoundaryPill`): one compact neutral centered pill with long-label clamp,
 * plus one themed dashed rule on EACH side — the row owns a different route
 * on each side (actual owner compares (topicId, branchId)), so both
 * available and missing forms paint both rules. The two forms differ only in
 * interaction authority — the missing form is the same pill without click
 * semantics, never a dimmed or differently shaped variant. Every materialized
 * relation layer renders its own divider, so layers stay independently
 * visible and independently navigable and are never merged into one row.
 * The context-window boundary keeps its own strong rule and is not part of
 * this family.
 */
export interface ReferenceDividerProps {
  reference: HistoryReferenceMeta
  /**
   * Topic that owns the rendered relation: the stable layer identity. A
   * chained reference renders one divider per materialized layer, each keyed
   * and tagged by its own relation target.
   */
  targetTopicId: string
  /** Live source topic title resolved from the current Redux topics. */
  sourceName: string | null
  onNavigateSource: () => void
}

/**
 * Cross-boundary decision for a history reference: actual owner compares
 * (topicId, branchId). A reference joins a foreign prefix to a target-owned
 * suffix, so both forms are cross-owner — the row always paints both dashed
 * rules. Pure, no DOM.
 */
export const isReferenceCrossOwner = (
  reference: Pick<HistoryReferenceMeta, 'sourceTopicId' | 'sourceBranchId'>,
  targetTopicId: string,
  targetBranchId?: string | null
): boolean => {
  try {
    if (reference.sourceTopicId !== targetTopicId) return true
    if (targetBranchId !== undefined) {
      return (reference.sourceBranchId ?? null) !== (targetBranchId ?? null)
    }
    return true
  } catch {
    return true
  }
}

export const ReferenceDivider = ({ reference, targetTopicId, sourceName, onNavigateSource }: ReferenceDividerProps) => {
  const { t } = useTranslation()
  const missing = reference.status === 'missing'
  const label = sourceName && sourceName.length > 0 ? sourceName : (reference.sourceName ?? '')
  const labelText = missing
    ? t('chat.message.reference_divider.missing')
    : t('chat.message.reference_divider.label', { name: label })
  const crossOwner = isReferenceCrossOwner(reference, targetTopicId)

  return (
    <ReferenceDividerRow
      data-testid="history-reference-divider"
      data-reference-status={reference.status}
      data-reference-source-topic={reference.sourceTopicId}
      data-reference-target-topic={targetTopicId}
      data-boundary-owner={crossOwner ? 'cross' : 'same'}>
      {crossOwner ? <BoundaryRule data-boundary-rule="dash" aria-hidden /> : null}
      {missing ? (
        <BoundaryPill data-testid="history-reference-divider-missing" data-boundary-pill="surface">
          <BoundaryLabel data-boundary-label>{labelText}</BoundaryLabel>
        </BoundaryPill>
      ) : (
        <BoundaryPillButton
          data-testid="history-reference-divider-link"
          type="text"
          size="small"
          autoInsertSpace={false}
          // A long source name is ellipsized inside the row, so the full name
          // stays available on hover and the button's accessible name stays the
          // untruncated text.
          title={labelText}
          onClick={onNavigateSource}>
          <BoundaryPill data-boundary-pill="surface">
            <BoundaryLabel data-boundary-label>{labelText}</BoundaryLabel>
          </BoundaryPill>
        </BoundaryPillButton>
      )}
      {crossOwner ? <BoundaryRule data-boundary-rule="dash" aria-hidden /> : null}
    </ReferenceDividerRow>
  )
}

/** Flow row of a reference divider: shared weak-boundary row, same height as before. */
const ReferenceDividerRow = styled(BoundaryRow)`
  min-height: 36px;
`
