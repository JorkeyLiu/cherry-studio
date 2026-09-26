import { getExternalModelEntry, getModelMetadataForDisplay } from '@renderer/config/models/modelMetadata'
import type { Model, Provider } from '@renderer/types'
import type { NormalizedModelMetadata } from '@shared/modelMetadata'

/**
 * Compact-display input-modality helpers (unit A).
 *
 * Canonical display order for the five models.dev input modalities. This is a
 * local display-only vocabulary: it never touches the persisted
 * ModelType/ModelTag keys and never migrates them.
 *
 * Single normalization truth shared by the compact supported-only projection
 * (`resolveSupportedInputModalities`) and the edit-UI tri-state summary
 * (`EditModelPopup/ModelCapabilityGroups.resolveInputModalityStates`): both
 * read `entry.modalities.input` through `getNormalizedInputModalitySet`.
 *
 * Compact rows and detail groups share one effective display resolver:
 * `getSupportedInputModalitiesForDisplay` → `getModelMetadataForDisplay(...).effective`
 * → `resolveSupportedInputModalities`. Canonical-lab reference serving wins,
 * canonical fills gaps, unknown renders empty; never the user's connection,
 * never writes back to Model.capabilities/type.
 */

export const INPUT_MODALITIES = ['text', 'image', 'audio', 'video', 'pdf'] as const
export type InputModality = (typeof INPUT_MODALITIES)[number]

/**
 * Local display-only filter vocabulary for compact rows / tag filters /
 * manage-tabs. Intentionally separate from the persisted `ModelTag` union so
 * persistence keys are never polluted.
 */
export type InputModalityFilter = InputModality

const SUPPORTED_INPUTS: ReadonlySet<string> = new Set<string>(INPUT_MODALITIES)

/** Exact known-modality guard for the five models.dev input values. */
export function isKnownInputModality(value: string): value is InputModality {
  return SUPPORTED_INPUTS.has(value)
}

/** Normalize raw input values to the known present set (lowercased, trimmed, known-only). */
export function normalizeInputModalityValues(input: unknown): Set<InputModality> {
  const present = new Set<InputModality>()
  if (!Array.isArray(input)) return present
  for (const raw of input) {
    const value = String(raw).trim().toLowerCase()
    if (isKnownInputModality(value)) present.add(value)
  }
  return present
}

/**
 * Single normalization truth for `entry.modalities.input`.
 *
 * Returns the known present set in no particular order; empty means unknown
 * (entry missing / input empty / zero known values). Compact supported-only
 * and detail tri-state both build on this set so they can never diverge.
 */
export function getNormalizedInputModalitySet(entry: NormalizedModelMetadata | undefined | null): Set<InputModality> {
  const input = entry?.modalities?.input
  if (!entry || !Array.isArray(input) || input.length === 0) return new Set<InputModality>()
  return normalizeInputModalityValues(input)
}

/**
 * Supported-only projection of an exact models.dev entry.
 *
 * Reads `entry.modalities.input` lowercase values exactly: only values
 * explicitly present and in the five known modalities are returned, in
 * canonical order. Unknown (entry missing / input empty) and unsupported
 * (absent from a known non-empty list) values are excluded — never rendered.
 */
export function resolveSupportedInputModalities(entry: NormalizedModelMetadata | undefined | null): InputModality[] {
  const present = getNormalizedInputModalitySet(entry)
  if (present.size === 0) return []
  return INPUT_MODALITIES.filter((modality) => present.has(modality))
}

/**
 * Canonical-only supported input modalities for a model (canonical identity).
 *
 * Resolution is exact-only via `getExternalModelEntry` (canonical models.dev
 * id matching, provider arg ignored). Display code must NOT use this helper;
 * use `getSupportedInputModalitiesForDisplay` which reads the effective
 * canonical-lab reference serving + canonical merge. Unknown means zero modalities.
 */
export function getSupportedInputModalities(
  model: Model | undefined | null,
  provider?: Provider | null
): InputModality[] {
  if (!model) return []
  return resolveSupportedInputModalities(getExternalModelEntry(model, provider))
}

/**
 * Display-layer supported input modalities for a model.
 *
 * Single display truth for all compact tags and filters: reads
 * `getModelMetadataForDisplay(model, provider).effective` (model-centric
 * reference inside `snapshot.providers[canonicalLab]`, never the user's
 * connection: canonical first, reference serving wins, unknown → empty) then
 * `resolveSupportedInputModalities`.
 * Compact rows (ModelTagsWithLabel) and detail groups (ModelCapabilityGroups
 * via entry) share this effective resolver so list and detail never diverge.
 * Never writes back to Model.capabilities/type/pricing; never merges serving
 * into canonical snapshot.
 */
export function getSupportedInputModalitiesForDisplay(
  model: Model | undefined | null,
  provider?: Provider | null
): InputModality[] {
  if (!model) return []
  return resolveSupportedInputModalities(getModelMetadataForDisplay(model, provider).effective)
}

/** Exact supported check for one modality (canonical-only, unknown → false). */
export function supportsInputModality(
  model: Model | undefined | null,
  modality: InputModality,
  provider?: Provider | null
): boolean {
  return getSupportedInputModalities(model, provider).includes(modality)
}

/** Display-layer exact supported check (canonical-lab reference serving wins, unknown → false). */
export function supportsInputModalityForDisplay(
  model: Model | undefined | null,
  modality: InputModality,
  provider?: Provider | null
): boolean {
  return getSupportedInputModalitiesForDisplay(model, provider).includes(modality)
}

export type ModalityModelRef = Model | { model: Model; provider?: Provider | null }

function normalizeRef(ref: ModalityModelRef): { model: Model; provider?: Provider | null } {
  if (ref && typeof ref === 'object' && 'model' in (ref as Record<string, unknown>)) {
    const { model, provider } = ref as { model: Model; provider?: Provider | null }
    return { model, provider }
  }
  return { model: ref as Model, provider: undefined }
}

/**
 * Availability map over a mixed list of models/refs: true only for modalities
 * with at least one exact supported occurrence (display-layer: canonical-lab
 * reference serving wins).
 * Unknown-only lists yield all false (zero tags / zero filter options).
 */
export function getInputModalityAvailability(items: ReadonlyArray<ModalityModelRef>): Record<InputModality, boolean> {
  const result: Record<InputModality, boolean> = { text: false, image: false, audio: false, video: false, pdf: false }
  let satisfied = 0
  for (const ref of items) {
    if (satisfied === INPUT_MODALITIES.length) break
    const { model, provider } = normalizeRef(ref)
    for (const modality of getSupportedInputModalitiesForDisplay(model, provider)) {
      if (!result[modality]) {
        result[modality] = true
        satisfied += 1
      }
    }
  }
  return result
}

/**
 * Provider-aware availability for popup-level tag filters (exact attribution per provider).
 * Display-layer: model-centric reference per model, canonical fills gaps.
 */
export function getInputModalityAvailabilityFromProviders(
  providers: ReadonlyArray<Provider>
): Record<InputModality, boolean> {
  const refs: ModalityModelRef[] = []
  for (const provider of providers) {
    for (const model of provider.models ?? []) {
      refs.push({ model, provider })
    }
  }
  return getInputModalityAvailability(refs)
}
