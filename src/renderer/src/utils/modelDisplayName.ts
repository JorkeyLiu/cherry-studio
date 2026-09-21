import { getModelMetadataForDisplay } from '@renderer/config/models/modelMetadata'
import type { Model, Provider } from '@renderer/types'

/**
 * Whether the persisted/form model name is a default ID-like name:
 * empty/blank or exactly mirroring the serving model ID (trimmed equality).
 * A genuine user-customized name returns false and must never be overwritten.
 * Case-sensitive, trim-based to match the selector's presentation intent.
 */
export function isDefaultModelName(name: string | undefined | null, id: string | undefined | null): boolean {
  const trimmedName = (name ?? '').trim()
  if (!trimmedName) return true
  const trimmedId = (id ?? '').trim()
  return trimmedName === trimmedId
}

/** Alias for the edit-popup's prior export name. */
export const isDefaultModelNameForEdit = isDefaultModelName

/**
 * Whether the model id should be shown next to the display name:
 * trimmed case-sensitive name differs from trimmed id.
 * Lightweight inverse of `isDefaultModelName` without the blank-name special,
 * kept as a single shared helper so list surfaces never repeat raw trim equality.
 */
export function shouldShowModelId(name: string | undefined | null, id: string | undefined | null): boolean {
  return (name?.trim() ?? '') !== (id?.trim() ?? '')
}

/**
 * Resolved models.dev display name for a Model+Provider, or undefined when
 * absent/blank/unknown. Synchronous, fail-open: never throws, never blocks.
 * Uses the existing `getModelMetadataForDisplay` contract (serving wins,
 * canonical fills gaps) and returns only its effective `name` when trimmed.
 */
export function getModelMetadataDisplayName(model: Model, provider: Provider | null | undefined): string | undefined {
  try {
    const display = getModelMetadataForDisplay(model, provider ?? null)
    const raw = display.effective?.name
    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    return trimmed ? trimmed : undefined
  } catch {
    return undefined
  }
}

/**
 * For an already-constructed Model, return the metadata display name when the
 * model's name is default-like (blank or equals id after trim), otherwise the
 * original name. Enrichment-only, synchronous, fail-open.
 */
export function resolveModelNameWithMetadata(model: Model, provider: Provider | null | undefined): string {
  if (!isDefaultModelName(model.name, model.id)) return model.name
  const meta = getModelMetadataDisplayName(model, provider)
  return meta ?? model.name
}

/**
 * Manual Add Model helper: explicit user-entered name wins when it is
 * non-blank and differs from the serving id after trim. Otherwise the name is
 * considered a system fallback and metadata is applied when available. Falls
 * back to the original construction (`explicit` or `id.toUpperCase()`) when
 * metadata is absent. Synchronous, fail-open.
 */
export function resolveManualAddModelName(
  id: string,
  explicitName: string | undefined | null,
  provider: Provider
): string {
  const trimmedId = (id ?? '').trim()
  const trimmedExplicit = (explicitName ?? '').trim()
  const isExplicit = !!trimmedExplicit && trimmedExplicit !== trimmedId
  if (isExplicit) {
    // Real user-entered name must win; preserve the trimmed explicit value
    // to avoid persisting stray whitespace while keeping the intended display.
    return trimmedExplicit
  }
  // Fallback-like: try metadata via a minimal Model keyed by the serving id.
  // The model's name for lookup is the id itself (identity is id-only).
  const tmpModel = { id: trimmedId, name: trimmedId, provider: provider.id } as Model
  const meta = getModelMetadataDisplayName(tmpModel, provider)
  if (meta) return meta
  if (trimmedExplicit) return trimmedExplicit // equals id, no metadata
  return trimmedId ? trimmedId.toUpperCase() : ''
}
