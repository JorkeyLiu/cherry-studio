import {
  FEATURE_COLORS,
  FEATURE_ICONS,
  FEATURE_LABEL_KEYS,
  MODALITY_DETAIL_COLORS,
  MODALITY_ICONS,
  type ModelFeatureKey
} from '@renderer/components/modelMetadataDisplay'
import CustomTag from '@renderer/components/Tags/CustomTag'
import { getNormalizedInputModalitySet, type InputModality } from '@renderer/utils/inputModalities'
import type { NormalizedModelMetadata } from '@shared/modelMetadata'
import { Flex } from 'antd'
import type { FC, ReactNode } from 'react'
import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

export type CapabilityState = 'supported' | 'unsupported' | 'unknown'

export type KnownCapabilityState = 'supported' | 'unsupported'

/**
 * Input-modality states from the exact models.dev entry only.
 *
 * Shares `getNormalizedInputModalitySet` with the compact supported-only
 * projection: entry missing / input empty / zero known values means the whole
 * group is unknown; a non-empty known set maps absent values to unsupported
 * (inactive). Unknown raw values never create a known group.
 */
export function resolveInputModalityStates(
  entry: NormalizedModelMetadata | undefined | null
): Record<InputModality, CapabilityState> {
  const unknownAll: Record<InputModality, CapabilityState> = {
    text: 'unknown',
    image: 'unknown',
    audio: 'unknown',
    video: 'unknown',
    pdf: 'unknown'
  }
  const present = getNormalizedInputModalitySet(entry)
  if (present.size === 0) return unknownAll
  return {
    text: present.has('text') ? 'supported' : 'unsupported',
    image: present.has('image') ? 'supported' : 'unsupported',
    audio: present.has('audio') ? 'supported' : 'unsupported',
    video: present.has('video') ? 'supported' : 'unsupported',
    pdf: present.has('pdf') ? 'supported' : 'unsupported'
  }
}

/** Feature tri-state from the exact entry boolean only (true/false/unknown). */
export function resolveFeatureState(value: boolean | undefined): CapabilityState {
  if (value === true) return 'supported'
  if (value === false) return 'unsupported'
  return 'unknown'
}

interface CapabilityItem {
  key: string
  label: string
  icon: ReactNode
  color: string
  state: KnownCapabilityState
  testId: string
}

const readOnlyStyle = { cursor: 'default' } as const

const CapabilityItemTag: FC<{ item: CapabilityItem; statusText: string }> = memo(({ item, statusText }) => {
  // Single native title on the wrapper only: the inner CustomTag renders
  // with no antd tooltip so there is never a duplicated tooltip.
  const tooltip = `${item.label}: ${statusText}`
  return (
    <span data-testid={item.testId} data-state={item.state} title={tooltip}>
      <CustomTag
        color={item.color}
        icon={item.icon}
        disabled
        inactive={item.state === 'unsupported'}
        style={readOnlyStyle}>
        {item.label}
      </CustomTag>
    </span>
  )
})
CapabilityItemTag.displayName = 'CapabilityItemTag'

interface ModelCapabilityGroupsProps {
  entry?: NormalizedModelMetadata | null
}

/**
 * Whether the Input Modalities group carries any known value.
 * Exported so the Edit Model empty-state can detect "all three groups empty".
 */
export function hasKnownInputModalities(entry: NormalizedModelMetadata | undefined | null): boolean {
  return getNormalizedInputModalitySet(entry).size > 0
}

/** Whether the Model Features group carries any known value. */
export function hasKnownFeatures(entry: NormalizedModelMetadata | undefined | null): boolean {
  return (
    entry?.reasoning !== undefined ||
    entry?.toolCall !== undefined ||
    entry?.structuredOutput !== undefined ||
    entry?.temperature !== undefined
  )
}

const MODALITY_KEYS: InputModality[] = ['text', 'image', 'audio', 'video', 'pdf']
const FEATURE_KEYS: ModelFeatureKey[] = ['reasoning', 'toolCall', 'structuredOutput', 'temperature']
const FEATURE_TEST_IDS: Record<ModelFeatureKey, string> = {
  reasoning: 'cap-feature-reasoning',
  toolCall: 'cap-feature-tool-call',
  structuredOutput: 'cap-feature-structured-output',
  temperature: 'cap-feature-temperature'
}

/**
 * Read-only capability summary for the model edit UI.
 *
 * Two icon groups (CustomTag, never clickable), each rendered only when it
 * carries at least one known value — a group without known items hides its
 * title and tags entirely, with no hint text:
 * - Input Modalities (Text/Image/Audio/Video/PDF) from entry.modalities.input
 *   with five-color CustomTag capsules (Text blue, Image green, Audio purple,
 *   Video magenta, PDF orange-red; hex only so the `color + '20'` background
 *   stays legal in both themes).
 * - Model Features (Reasoning/Tool Call/Structured Output/Temperature) from
 *   entry booleans with four distinct theme-friendly colors (Reasoning
 *   indigo, Tool Call orange, Structured cyan, Temperature magenta; never
 *   warning orange). Only known states render as tags: supported stays
 *   colored, unsupported stays gray inactive. Unknown values never render
 *   per-item tags. Each tag carries a single native title
 *   (Supported/Not supported); the inner CustomTag renders no antd tooltip.
 */
const ModelCapabilityGroups: FC<ModelCapabilityGroupsProps> = ({ entry }) => {
  const { t } = useTranslation()

  const statusLabels = useMemo(
    () => ({
      supported: t('models.reference.supported'),
      unsupported: t('models.reference.unsupported')
    }),
    [t]
  )

  const modalities = useMemo(() => resolveInputModalityStates(entry ?? undefined), [entry])
  const features = useMemo(
    () => ({
      reasoning: resolveFeatureState(entry?.reasoning),
      toolCall: resolveFeatureState(entry?.toolCall),
      structuredOutput: resolveFeatureState(entry?.structuredOutput),
      temperature: resolveFeatureState(entry?.temperature)
    }),
    [entry]
  )

  const modalityItems: CapabilityItem[] = useMemo(() => {
    const all: Array<CapabilityItem & { rawState: CapabilityState }> = MODALITY_KEYS.map((key) => {
      const Icon = MODALITY_ICONS[key]
      return {
        key,
        label: t(
          key === 'text'
            ? 'models.capabilities.modality_text'
            : key === 'image'
              ? 'models.capabilities.modality_image'
              : key === 'audio'
                ? 'models.capabilities.modality_audio'
                : key === 'video'
                  ? 'models.capabilities.modality_video'
                  : 'models.capabilities.modality_pdf'
        ),
        icon: <Icon size={12} />,
        color: MODALITY_DETAIL_COLORS[key],
        state: modalities[key] as KnownCapabilityState,
        rawState: modalities[key],
        testId: `cap-modality-${key}`
      }
    })
    return all.filter((item) => item.rawState !== 'unknown')
  }, [modalities, t])

  const featureItems: CapabilityItem[] = useMemo(() => {
    const all: Array<CapabilityItem & { rawState: CapabilityState }> = FEATURE_KEYS.map((key) => {
      const Icon = FEATURE_ICONS[key]
      return {
        key,
        label: t(FEATURE_LABEL_KEYS[key]),
        icon: <Icon size={12} />,
        color: FEATURE_COLORS[key],
        state: features[key] as KnownCapabilityState,
        rawState: features[key],
        testId: FEATURE_TEST_IDS[key]
      }
    })
    return all.filter((item) => item.rawState !== 'unknown')
  }, [features, t])

  // Groups without any known item hide entirely (title included): a group
  // with data renders only its known tags, with no hint text either way.
  if (modalityItems.length === 0 && featureItems.length === 0) return null

  return (
    <GroupsWrap data-testid="model-capabilities">
      {modalityItems.length > 0 && (
        <>
          <GroupTitle data-testid="input-modalities-title">{t('models.capabilities.input_modalities')}</GroupTitle>
          <Flex data-testid="input-modalities" justify="flex-start" align="center" gap={4} wrap="wrap">
            {modalityItems.map((item) => (
              <CapabilityItemTag key={item.key} item={item} statusText={statusLabels[item.state]} />
            ))}
          </Flex>
        </>
      )}
      {featureItems.length > 0 && (
        <>
          <GroupTitle data-testid="model-features-title">{t('models.capabilities.features')}</GroupTitle>
          <Flex data-testid="model-features" justify="flex-start" align="center" gap={4} wrap="wrap">
            {featureItems.map((item) => (
              <CapabilityItemTag key={item.key} item={item} statusText={statusLabels[item.state]} />
            ))}
          </Flex>
        </>
      )}
    </GroupsWrap>
  )
}

const GroupsWrap = styled.div`
  margin-bottom: 8px;
`

const GroupTitle = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 12px 0 8px 0;
  font-size: 14px;
  font-weight: 600;
`

export default memo(ModelCapabilityGroups)
