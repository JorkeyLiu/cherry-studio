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

/** USD per-million reference price, rendered deterministically for tests. */
export function formatReferencePrice(value: number): string {
  return `$${String(value)}`
}

/** Token limits render with en-US grouping (e.g. 200000 -> 200,000). */
export function formatLimitTokens(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * Reasoning effort display from actually published effort values only.
 *
 * Only the raw models.dev `effort` array is shown (e.g. low, high, max via
 * join(', ')). Toggle/budget are never shown and Supported wording is never
 * used. Empty/missing effort is unknown, so the row hides: it never renders
 * a Not supported placeholder and never triggers section visibility alone.
 */
export function formatReasoningControls(controls: NormalizedModelMetadata['reasoningControls']): {
  text: string
  known: boolean
} {
  const effort = Array.isArray(controls?.effort)
    ? controls.effort.map((v) => String(v).trim()).filter((v) => v.length > 0)
    : []
  if (effort.length > 0) return { text: effort.join(', '), known: true }
  return { text: '', known: false }
}

/**
 * Whether the entry carries any concrete Model Data row (pricing, context
 * limit, dates, tier note). Reasoning effort alone never counts: features
 * already show in the icon group above. Exported so the Edit Model
 * empty-state can detect "all three groups empty".
 */
export function hasConcreteModelData(entry: NormalizedModelMetadata | undefined | null): boolean {
  if (!entry || typeof entry !== 'object') return false
  const pricing = entry.pricing
  if (pricing && typeof pricing === 'object') {
    for (const value of [
      pricing.input,
      pricing.output,
      pricing.cacheRead,
      pricing.cacheWrite,
      pricing.reasoning,
      pricing.inputAudio,
      pricing.outputAudio,
      pricing.contextOver200k
    ]) {
      if (typeof value === 'number' && Number.isFinite(value)) return true
    }
    if (pricing.hasTiers === true) return true
  }
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
  /** Concrete rows (pricing/limits/dates/tier note) gate section visibility. */
  concrete: boolean
}

/**
 * Read-only models.dev model-data section for the model edit UI.
 *
 * Takes the already reactively computed `entry` from ModelEditContent (which
 * subscribes to the registry status): this component never looks the entry up
 * itself, so async snapshot resolution always flows into the open popup for
 * both capability icons and model data together. Never writes, never applies,
 * never edits: it only displays published metadata. Capability icons live in
 * ModelCapabilityGroups; this section keeps pricing, context limit, dates,
 * tier note, and effort-only reasoning controls.
 */
const ModelMetadataReference: FC<{ entry?: NormalizedModelMetadata | null }> = ({ entry }) => {
  const { t } = useTranslation()

  const rows = useMemo<ReferenceRow[]>(() => {
    if (!entry || typeof entry !== 'object') return []
    const out: ReferenceRow[] = []
    const pricing = entry.pricing
    const limits = entry.limits
    const unit = t('models.reference.per_million_tokens')

    if (pricing && typeof pricing === 'object') {
      const priced: Array<{ key: string; labelKey: string; value: unknown; testId: string }> = [
        { key: 'input', labelKey: 'models.reference.input', value: pricing.input, testId: 'ref-price-input' },
        { key: 'output', labelKey: 'models.reference.output', value: pricing.output, testId: 'ref-price-output' },
        {
          key: 'cacheRead',
          labelKey: 'models.reference.cache_read',
          value: pricing.cacheRead,
          testId: 'ref-price-cache-read'
        },
        {
          key: 'cacheWrite',
          labelKey: 'models.reference.cache_write',
          value: pricing.cacheWrite,
          testId: 'ref-price-cache-write'
        },
        {
          key: 'reasoning',
          labelKey: 'models.reference.reasoning',
          value: pricing.reasoning,
          testId: 'ref-price-reasoning'
        },
        {
          key: 'inputAudio',
          labelKey: 'models.reference.input_audio',
          value: pricing.inputAudio,
          testId: 'ref-price-input-audio'
        },
        {
          key: 'outputAudio',
          labelKey: 'models.reference.output_audio',
          value: pricing.outputAudio,
          testId: 'ref-price-output-audio'
        },
        {
          key: 'contextOver200k',
          labelKey: 'models.reference.context_over_200k',
          value: pricing.contextOver200k,
          testId: 'ref-price-context-over-200k'
        }
      ]
      for (const item of priced) {
        if (isDisplayNumber(item.value)) {
          out.push({
            key: `pricing.${item.key}`,
            label: t(item.labelKey),
            value: `${formatReferencePrice(item.value)} ${unit}`,
            testId: item.testId,
            known: true,
            concrete: true
          })
        }
      }
      if (pricing.hasTiers === true) {
        out.push({
          key: 'pricing.hasTiers',
          label: t('models.reference.tiered_pricing'),
          value: t('models.reference.tiered_pricing_note'),
          testId: 'ref-price-tiers',
          known: true,
          concrete: true
        })
      }
    }

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

    // Reasoning effort renders only when the source publishes effort values;
    // otherwise the row hides entirely (no Not supported placeholder).
    const effortFormatted = formatReasoningControls(entry.reasoningControls)
    if (effortFormatted.known) {
      out.push({
        key: 'reasoningControls',
        label: t('models.reference.reasoning_controls'),
        value: effortFormatted.text,
        testId: 'ref-reasoning-controls',
        known: true,
        concrete: false
      })
    }

    return out
  }, [entry, t])

  // The section shows only when concrete model data exists (pricing, context
  // limit, dates, tier note). The effort-only row never triggers visibility
  // alone, so a features-only or effort-only entry stays hidden because
  // features already show in the icon group above.
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
