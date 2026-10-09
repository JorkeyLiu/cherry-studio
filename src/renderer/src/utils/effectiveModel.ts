import type { Model } from '@renderer/types'

/**
 * Configured serving-model reference guard (projection normalization only).
 *
 * A persisted model selection is a serving request identity only when it
 * carries a non-empty string serving `id` and a non-empty string owning
 * `provider` id. Display/group metadata must not be required: a valid
 * user-defined serving selection with missing display metadata stays
 * accepted (Model Metadata ADR MM-1/MM-3 enrichment-only, never gate).
 *
 * Missing/invalid yields `undefined` (explicitly unconfigured) — never `''`
 * coercion, never lazy fallback to another provider/model, never verbatim
 * mutation. Valid inputs keep object identity and capabilities untouched.
 */
export function isConfiguredServingModel(model: unknown): model is Model {
  if (!model || typeof model !== 'object') {
    return false
  }
  const candidate = model as Partial<Model>
  return (
    typeof candidate.id === 'string' &&
    candidate.id.trim().length > 0 &&
    typeof candidate.provider === 'string' &&
    candidate.provider.trim().length > 0
  )
}

/**
 * Normalize a picked effective-model choice to an explicit unconfigured
 * slot. Call AFTER the existing nullish precedence pick
 * (`a ?? b ?? c`), so a present-but-malformed choice stays unconfigured
 * instead of silently falling through to the next valid default.
 */
export function asConfiguredServingModel(model: unknown): Model | undefined {
  return isConfiguredServingModel(model) ? model : undefined
}
