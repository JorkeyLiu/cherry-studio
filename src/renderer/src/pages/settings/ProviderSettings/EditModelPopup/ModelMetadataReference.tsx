import { getExternalModelEntry } from '@renderer/config/models/modelMetadata'
import type { Model, Provider } from '@renderer/types'
import { MODEL_METADATA_SOURCE, type NormalizedModelMetadata } from '@shared/modelMetadata'
import { Button, Divider, Flex } from 'antd'
import type { FC } from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface ModelMetadataReferenceProps {
  model: Model
  provider?: Provider | null
  onUseReferencePricing?: (inputPerMillion: number, outputPerMillion: number) => void
}

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

interface ReferenceRow {
  key: string
  label: string
  value: string
  testId: string
}

/**
 * Read-only models.dev reference section for the model edit UI.
 *
 * Exact owning-provider + exact model-id match only (via
 * getExternalModelEntry). Never writes, never auto-applies: the only
 * mutation path is the explicit `onUseReferencePricing` callback, which
 * carries only the two fields representable by `Model.pricing`.
 * Missing/partial/malformed metadata hides rows (or the whole section)
 * without blocking model editing.
 */
const ModelMetadataReference: FC<ModelMetadataReferenceProps> = ({ model, provider, onUseReferencePricing }) => {
  const { t } = useTranslation()
  const entry: NormalizedModelMetadata | undefined = useMemo(
    () => getExternalModelEntry(model, provider),
    [model, provider]
  )

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
            testId: item.testId
          })
        }
      }
      if (pricing.hasTiers === true) {
        out.push({
          key: 'pricing.hasTiers',
          label: t('models.reference.status'),
          value: t('models.reference.tiered_pricing_note'),
          testId: 'ref-price-tiers'
        })
      }
    }

    if (limits && typeof limits === 'object') {
      if (isDisplayNumber(limits.context)) {
        out.push({
          key: 'limits.context',
          label: t('models.reference.context_limit'),
          value: formatLimitTokens(limits.context),
          testId: 'ref-limit-context'
        })
      }
      if (isDisplayNumber(limits.input)) {
        out.push({
          key: 'limits.input',
          label: t('models.reference.input_limit'),
          value: formatLimitTokens(limits.input),
          testId: 'ref-limit-input'
        })
      }
      if (isDisplayNumber(limits.output)) {
        out.push({
          key: 'limits.output',
          label: t('models.reference.output_limit'),
          value: formatLimitTokens(limits.output),
          testId: 'ref-limit-output'
        })
      }
    }

    if (isDisplayText(entry.family)) {
      out.push({
        key: 'family',
        label: t('models.reference.family'),
        value: entry.family.trim(),
        testId: 'ref-family'
      })
    }
    if (isDisplayText(entry.status)) {
      out.push({
        key: 'status',
        label: t('models.reference.status'),
        value: entry.status.trim(),
        testId: 'ref-status'
      })
    }
    if (isDisplayText(entry.releaseDate)) {
      out.push({
        key: 'releaseDate',
        label: t('models.reference.release_date'),
        value: entry.releaseDate.trim(),
        testId: 'ref-release-date'
      })
    }
    if (isDisplayText(entry.knowledgeCutoff)) {
      out.push({
        key: 'knowledgeCutoff',
        label: t('models.reference.knowledge_cutoff'),
        value: entry.knowledgeCutoff.trim(),
        testId: 'ref-knowledge-cutoff'
      })
    }
    return out
  }, [entry, t])

  const adoptable =
    entry?.pricing &&
    typeof entry.pricing === 'object' &&
    isDisplayNumber(entry.pricing.input) &&
    isDisplayNumber(entry.pricing.output)
      ? { input: entry.pricing.input, output: entry.pricing.output }
      : undefined

  if (!entry || rows.length === 0) return null

  return (
    <ReferenceWrap data-testid="models-dev-reference">
      <Divider style={{ margin: '16px 0 12px 0' }} />
      <Flex justify="space-between" align="center" gap={8}>
        <ReferenceTitle>
          {t('models.reference.title')} <SourceTag data-testid="ref-source">{MODEL_METADATA_SOURCE}</SourceTag>
        </ReferenceTitle>
        {adoptable && (
          <Button
            size="small"
            data-testid="use-reference-pricing"
            onClick={() => onUseReferencePricing?.(adoptable.input, adoptable.output)}>
            {t('models.reference.use_pricing')}
          </Button>
        )}
      </Flex>
      <ReferenceNote>{t('models.reference.description')}</ReferenceNote>
      <Rows>
        {rows.map((row) => (
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

const ReferenceNote = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
  margin: 6px 0 10px 0;
`

const Rows = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
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
