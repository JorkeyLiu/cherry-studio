import { getModelMetadataForDisplay, type ModelMetadataDisplaySources } from '@renderer/config/models/modelMetadata'
import type { Model, Provider } from '@renderer/types'

import { isDefaultModelName } from './modelDisplayName'

export interface ModelPresentation {
  /** Original model reference (identity unchanged). */
  model: Model
  provider: Provider | null
  /** Resolved display name: real provider/user name wins; only blank/id-like uses effective.name; fail-open to original. */
  displayName: string
  /** Effective merged metadata for tags/modalities etc., or undefined when none. */
  effective?: ModelMetadataDisplaySources['effective']
  /** Serving/canonical source marker. */
  source: ModelMetadataDisplaySources['source']
}

/**
 * Readonly presentation projection built on existing `getModelMetadataForDisplay`.
 * Single metadata call drives both displayName and effective; no writes, no id changes,
 * no new matching heuristics. Fail-open to original name/id.
 */
export function getModelPresentation(model: Model, provider: Provider | null | undefined): ModelPresentation {
  try {
    const display = getModelMetadataForDisplay(model, provider ?? null)
    const effective = display.effective
    const source = display.source
    const isDefault = isDefaultModelName(model.name, model.id)
    let displayName: string
    if (!isDefault) {
      displayName = model.name
    } else {
      const metaName = effective?.name?.trim()
      if (metaName) {
        displayName = metaName
      } else {
        displayName = model.name
      }
    }
    // Ensure we never return blank when original had value; fail-open prefers original name/id
    if (!displayName?.trim()) {
      displayName = model.name?.trim() ? model.name : model.id
    }
    return {
      model,
      provider: provider ?? null,
      displayName,
      effective,
      source
    }
  } catch {
    // Fail-open: never throws
    return {
      model,
      provider: provider ?? null,
      displayName: model.name?.trim() ? model.name : model.id,
      effective: undefined,
      source: 'none'
    }
  }
}

/**
 * Helper for ID-aware search over presentation: displayName + exact id + provider name/id.
 * Lowercased handling delegated to includeKeywords.
 */
export function getModelPresentationSearchText(presentation: ModelPresentation): string {
  const { displayName, model, provider } = presentation
  const parts = [displayName, model.id, model.name, provider?.name ?? '', provider?.id ?? '']
  return parts.filter(Boolean).join(' ')
}
