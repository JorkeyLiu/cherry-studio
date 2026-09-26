import { HelpTooltip } from '@renderer/components/TooltipIcons'
import {
  MODEL_METADATA_SOURCE,
  type NormalizedModelMetadata,
  type NormalizedProviderServingCost
} from '@shared/modelMetadata'
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

/**
 * Untranslated technical per-million-token unit for Edit Model price rows.
 * Always renders exactly ` / M Token` (e.g. `$0.15 / M Token`) in every
 * locale; intentionally not an i18n key so it is never translated.
 */
export const REFERENCE_PRICE_UNIT = ' / M Token'

/** Token limits render with en-US grouping (e.g. 200000 -> 200,000). */
export function formatLimitTokens(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * Reasoning effort display from published serving `effort` only.
 * Only the normalized effort array is shown (e.g. low, high, xhigh via
 * join(', ')). Empty/missing effort is unknown, so the row hides: it never
 * renders a Not supported placeholder and never triggers section visibility
 * alone. Accepts either a raw effort array or a legacy `{effort}` wrapper.
 */
export function formatReasoningControls(effortOrWrapper: unknown): { text: string; known: boolean } {
  const rawEffort = Array.isArray(effortOrWrapper)
    ? effortOrWrapper
    : isRecord(effortOrWrapper) && Array.isArray((effortOrWrapper as { effort?: unknown }).effort)
      ? (effortOrWrapper as { effort: unknown[] }).effort
      : undefined
  const effort = Array.isArray(rawEffort) ? rawEffort.map((v) => String(v).trim()).filter((v) => v.length > 0) : []
  if (effort.length > 0) return { text: effort.join(', '), known: true }
  return { text: '', known: false }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type EffectiveModelMetadataEntry = NormalizedModelMetadata & {
  cost?: NormalizedProviderServingCost
  effort?: string[]
}

/**
 * Whether the entry carries any concrete Model Data row (pricing via cost,
 * context/output limits, dates). Reasoning effort alone never counts: features
 * already show in the icon group above. Exported so the Edit Model
 * empty-state can detect "all three groups empty".
 */
export function hasConcreteModelData(
  entry: EffectiveModelMetadataEntry | NormalizedModelMetadata | undefined | null
): boolean {
  if (!entry || typeof entry !== 'object') return false
  if (entry.limits && typeof entry.limits === 'object') {
    if (typeof entry.limits.context === 'number' && Number.isFinite(entry.limits.context)) return true
    if (typeof entry.limits.output === 'number' && Number.isFinite(entry.limits.output)) return true
  }
  const cost = (entry as EffectiveModelMetadataEntry).cost
  if (cost && typeof cost === 'object') {
    for (const value of [cost.input, cost.output, cost.cacheRead, cost.cacheWrite]) {
      if (typeof value === 'number' && Number.isFinite(value)) return true
    }
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
  /** Concrete rows (pricing/limits/dates) gate section visibility. */
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
 * ModelCapabilityGroups; this section keeps pricing (via effective.cost),
 * context/output limits, dates, and effort-only reasoning controls. Reference
 * serving wins, canonical fills only missing fields (resolved upstream via
 * getModelMetadataForDisplay from the canonical lab, never the user
 * connection); this view only reads the effective result. Family/status/
 * description/lastUpdated/limits.input/tiering/button are intentionally not
 * restored. Prices, limits, and capabilities are third-party reference info
 * about the model and may differ from the current custom provider/endpoint;
 * the upstream service is authoritative (see the HelpTooltip below).
 */
const ModelMetadataReference: FC<{ entry?: EffectiveModelMetadataEntry | null }> = ({ entry }) => {
  const { t } = useTranslation()

  const rows = useMemo<ReferenceRow[]>(() => {
    if (!entry || typeof entry !== 'object') return []
    const out: ReferenceRow[] = []
    const limits = entry.limits
    const cost = entry.cost
    const effort = entry.effort

    if (cost && typeof cost === 'object') {
      const priced: Array<{ key: string; labelKey: string; value: unknown; testId: string }> = [
        { key: 'input', labelKey: 'models.reference.input', value: cost.input, testId: 'ref-price-input' },
        { key: 'output', labelKey: 'models.reference.output', value: cost.output, testId: 'ref-price-output' },
        {
          key: 'cacheRead',
          labelKey: 'models.reference.cache_read',
          value: cost.cacheRead,
          testId: 'ref-price-cache-read'
        },
        {
          key: 'cacheWrite',
          labelKey: 'models.reference.cache_write',
          value: cost.cacheWrite,
          testId: 'ref-price-cache-write'
        }
      ]
      for (const item of priced) {
        if (isDisplayNumber(item.value)) {
          out.push({
            key: `cost.${item.key}`,
            label: t(item.labelKey),
            value: `${formatReferencePrice(item.value)}${REFERENCE_PRICE_UNIT}`,
            testId: item.testId,
            known: true,
            concrete: true
          })
        }
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
      if (isDisplayNumber(limits.output)) {
        out.push({
          key: 'limits.output',
          label: t('models.reference.output_limit'),
          value: formatLimitTokens(limits.output),
          testId: 'ref-limit-output',
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

    const effortFormatted = formatReasoningControls(effort)
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

  // The section shows only when concrete model data exists (pricing via cost,
  // context/output limits, dates). The effort-only row never triggers
  // visibility alone, so a features-only or effort-only entry stays hidden
  // because features already show in the icon group above.
  const hasConcreteValue = rows.some((row) => row.known && row.concrete)
  if (!entry || !hasConcreteValue) return null
  const visibleRows = rows.filter((row) => row.known)

  return (
    <ReferenceWrap data-testid="models-dev-reference">
      <Divider style={{ margin: '16px 0 12px 0' }} />
      <Flex justify="space-between" align="center" gap={8}>
        <ReferenceTitle>
          {t('models.reference.title')} <SourceTag data-testid="ref-source">{MODEL_METADATA_SOURCE}</SourceTag>
          <span data-testid="ref-disclaimer-tip" title={t('models.reference.disclaimer_tooltip')}>
            <HelpTooltip title={t('models.reference.disclaimer_tooltip')} />
          </span>
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
