import { MODEL_METADATA_SOURCE, type NormalizedModelMetadata } from '@shared/modelMetadata'
import { Divider, Flex } from 'antd'
import type { FC } from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

function isDisplayNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isDisplayText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Token limits render with en-US grouping (e.g. 200000 -> 200,000). */
export function formatLimitTokens(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * Whether the entry carries any concrete Model Data row (context limit,
 * dates). Canonical `models.json` publishes no provider-specific pricing or
 * reasoning options, so those rows never render: they read as unknown/absent
 * (never filled from proxy-serving records). Reasoning effort alone never
 * counts: features already show in the icon group above. Exported so the
 * Edit Model empty-state can detect "all three groups empty".
 */
export function hasConcreteModelData(entry: NormalizedModelMetadata | undefined | null): boolean {
  if (!entry || typeof entry !== 'object') return false
  if (entry.limits && typeof entry.limits === 'object') {
    if (typeof entry.limits.context === 'number' && Number.isFinite(entry.limits.context)) return true
  }
  if (typeof entry.releaseDate === 'string' && entry.releaseDate.trim().length > 0) return true
  if (typeof entry.knowledgeCutoff === 'string' && entry.knowledgeCutoff.trim().length > 0) return true
  return false
}

interface ReferenceRow {
  key: string
  label: string
  value: string
  testId: string
  /** Whether the row carries a known value. */
  known: boolean
  /** Concrete rows (limits/dates) gate section visibility. */
  concrete: boolean
}

/**
 * Read-only models.dev model-data section for the model edit UI.
 *
 * Takes the already reactively computed `entry` from ModelEditContent (which
 * subscribes to the registry status): this component never looks the entry up
 * itself, so async snapshot resolution always flows into the open popup for
 * both capability icons and model data together. Never writes, never applies,
 * never edits: it only displays published canonical metadata. Capability
 * icons live in ModelCapabilityGroups; this section keeps context limit and
 * dates. Pricing and reasoning-option rows never render: canonical
 * `models.json` does not publish them, so they read as unknown/absent.
 */
const ModelMetadataReference: FC<{ entry?: NormalizedModelMetadata | null }> = ({ entry }) => {
  const { t } = useTranslation()

  const rows = useMemo<ReferenceRow[]>(() => {
    if (!entry || typeof entry !== 'object') return []
    const out: ReferenceRow[] = []
    const limits = entry.limits

    if (limits && typeof limits === 'object') {
      if (isDisplayNumber(limits.context)) {
        out.push({
          key: 'limits.context',
          label: t('models.reference.context_limit'),
          value: formatLimitTokens(limits.context),
          testId: 'ref-limit-context',
          known: true,
          concrete: true
        })
      }
    }

    if (isDisplayText(entry.releaseDate)) {
      out.push({
        key: 'releaseDate',
        label: t('models.reference.release_date'),
        value: entry.releaseDate.trim(),
        testId: 'ref-release-date',
        known: true,
        concrete: true
      })
    }
    if (isDisplayText(entry.knowledgeCutoff)) {
      out.push({
        key: 'knowledgeCutoff',
        label: t('models.reference.knowledge_cutoff'),
        value: entry.knowledgeCutoff.trim(),
        testId: 'ref-knowledge-cutoff',
        known: true,
        concrete: true
      })
    }

    return out
  }, [entry, t])

  // The section shows only when concrete model data exists (context limit,
  // dates). A features-only entry stays hidden because features already show
  // in the icon group above.
  const hasConcreteValue = rows.some((row) => row.known && row.concrete)
  if (!entry || !hasConcreteValue) return null
  const visibleRows = rows.filter((row) => row.known)

  return (
    <ReferenceWrap data-testid="models-dev-reference">
      <Divider style={{ margin: '16px 0 12px 0' }} />
      <Flex justify="space-between" align="center" gap={8}>
        <ReferenceTitle>
          {t('models.reference.title')} <SourceTag data-testid="ref-source">{MODEL_METADATA_SOURCE}</SourceTag>
        </ReferenceTitle>
      </Flex>
      <Rows>
        {visibleRows.map((row) => (
          <Flex key={row.key} justify="space-between" align="baseline" gap={12}>
            <RowLabel>{row.label}</RowLabel>
            <RowValue data-testid={row.testId}>{row.value}</RowValue>
          </Flex>
        ))}
      </Rows>
    </ReferenceWrap>
  )
}

const ReferenceWrap = styled.div`
  margin-bottom: 8px;
`

const ReferenceTitle = styled.div`
  font-size: 14px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
`

const SourceTag = styled.span`
  font-size: 12px;
  font-weight: 400;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--color-border);
  color: var(--color-text-2);
  white-space: nowrap;
`

const Rows = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
`

const RowLabel = styled.span`
  font-size: 13px;
  color: var(--color-text-2);
`

const RowValue = styled.span`
  font-size: 13px;
  color: var(--color-text-1);
  text-align: right;
  word-break: break-word;
`

export default ModelMetadataReference
