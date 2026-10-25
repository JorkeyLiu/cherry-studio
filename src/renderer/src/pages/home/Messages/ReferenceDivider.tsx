import type { HistoryReferenceMeta } from '@shared/chatDb'
import { Button } from 'antd'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

/**
 * Cross-topic history-reference divider.
 *
 * Marks the boundary between the read-only foreign prefix and the target-owned
 * writable suffix. The available form shows the LIVE source topic name as a
 * link that navigates to the captured source topic + branch + exact anchor
 * message; the missing form (source/branch/anchor gone) shows the missing
 * label while the target topic and its own suffix survive.
 *
 * Reference-specific minimal component: reuses the surrounding divider line
 * styling (ForkDivider/context divider family), never recreates the branch
 * subsystem.
 */
export interface ReferenceDividerProps {
  reference: HistoryReferenceMeta
  /** Live source topic title resolved from the current Redux topics. */
  sourceName: string | null
  onNavigateSource: () => void
}

export const ReferenceDivider = ({ reference, sourceName, onNavigateSource }: ReferenceDividerProps) => {
  const { t } = useTranslation()
  const missing = reference.status === 'missing'
  const label = sourceName && sourceName.length > 0 ? sourceName : (reference.sourceName ?? '')

  return (
    <ReferenceDividerRow
      data-testid="history-reference-divider"
      data-reference-status={reference.status}
      data-reference-source-topic={reference.sourceTopicId}>
      <ReferenceDividerLine />
      {missing ? (
        <ReferenceDividerText data-testid="history-reference-divider-missing">
          {t('chat.message.reference_divider.missing')}
        </ReferenceDividerText>
      ) : (
        <ReferenceDividerButton
          data-testid="history-reference-divider-link"
          type="text"
          size="small"
          autoInsertSpace={false}
          onClick={onNavigateSource}>
          {t('chat.message.reference_divider.label', { name: label })}
        </ReferenceDividerButton>
      )}
      <ReferenceDividerLine />
    </ReferenceDividerRow>
  )
}

const ReferenceDividerRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  margin: 4px 0;
  min-height: 36px;
`

const ReferenceDividerLine = styled.div`
  flex: 1;
  height: 1px;
  background: var(--color-border);
`

const ReferenceDividerText = styled.span`
  font-size: 12px;
  color: var(--color-text-3);
  white-space: nowrap;
`

const ReferenceDividerButton = styled(Button)`
  font-size: 12px;
  color: var(--color-text-2);
  white-space: nowrap;
  height: auto;
  padding: 0 8px;
`
