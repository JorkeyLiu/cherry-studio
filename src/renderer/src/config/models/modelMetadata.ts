import {
  lookupModelMetadata,
  resolveMetadataSource,
  resolveProviderForMetadata
} from '@renderer/services/modelMetadata'
import type { Model, Provider, ReasoningEffortOption } from '@renderer/types'
import { isUserSelectedModelType } from '@renderer/utils'
import type { ModelMetadataReasoningControls, NormalizedModelMetadata } from '@shared/modelMetadata'

/**
 * Tri-state capability resolvers over the optional models.dev registry.
 *
 * This module is intentionally pure: it never imports AssistantService or
 * the store/data-source chain (that edge caused a deterministic
 * collection-time TDZ). Provider attribution flows through the injected
 * `resolveProviderForMetadata` accessor instead.
 *
 * Priority everywhere: explicit user override
 * (`capabilities[].isUserSelected`) -> validated external metadata -> legacy
 * heuristic fallback (owned by the existing predicates, untouched here).
 *
 * Every resolver returns true/false only for validated known values and
 * undefined for unknown (absent snapshot, unmapped provider, unmapped model
 * id, or absent upstream field). Unknown must never harden into a rejection:
 * callers fall through to the legacy heuristic and unknown ids still reach
 * request resolution.
 */

/**
 * Strict owning-provider lookup for external attribution.
 *
 * Attribution requires the exact owning provider: a resolver result whose id
 * does not equal the model's own provider id is treated as unknown (this
 * also neutralizes any silent default-provider substitution). An explicit
 * provider argument (including explicit null = known absent) bypasses the
 * accessor.
 */
export function strictProviderForModel(model: Model | undefined | null, explicit?: Provider | null): Provider | null {
  return resolveProviderForMetadata(model, explicit)
}

/** Exact-match external entry for a model, or undefined when unknown. */
export function getExternalModelEntry(
  model: Model | undefined | null,
  provider?: Provider | null
): NormalizedModelMetadata | undefined {
  if (!model || typeof model.id !== 'string') return undefined
  const source = resolveMetadataSource(strictProviderForModel(model, provider))
  return lookupModelMetadata(source, model.id)
}

/**
 * Vision support from external metadata: `modalities.input includes image`.
 * Attachment is deliberately NOT consulted (it describes file upload, not
 * image understanding). An empty/absent input list means unknown.
 */
export function resolveExternalVisionSupport(
  model: Model | undefined | null,
  provider?: Provider | null
): boolean | undefined {
  const entry = getExternalModelEntry(model, provider)
  if (!entry) return undefined
  const input = entry.modalities?.input
  if (!Array.isArray(input) || input.length === 0) return undefined
  return input.includes('image')
}

/** Tool-calling support from external `tool_call` (absent means unknown). */
export function resolveExternalToolCallSupport(
  model: Model | undefined | null,
  provider?: Provider | null
): boolean | undefined {
  const entry = getExternalModelEntry(model, provider)
  if (!entry || entry.toolCall === undefined) return undefined
  return entry.toolCall
}

/** Reasoning support from external `reasoning` (absent means unknown). */
export function resolveExternalReasoningSupport(
  model: Model | undefined | null,
  provider?: Provider | null
): boolean | undefined {
  const entry = getExternalModelEntry(model, provider)
  if (!entry || entry.reasoning === undefined) return undefined
  return entry.reasoning
}

/** Temperature support from external `temperature` (absent means unknown). */
export function resolveExternalTemperatureSupport(
  model: Model | undefined | null,
  provider?: Provider | null
): boolean | undefined {
  const entry = getExternalModelEntry(model, provider)
  if (!entry || entry.temperature === undefined) return undefined
  return entry.temperature
}

/** Typed external reasoning controls, if the source publishes any. */
export function getExternalReasoningControls(
  model: Model | undefined | null,
  provider?: Provider | null
): ModelMetadataReasoningControls | undefined {
  return getExternalModelEntry(model, provider)?.reasoningControls
}

/**
 * External reasoning-effort options for effort-option construction.
 *
 * Additive only: returns undefined unless the entry is known-reasoning.
 * Known effort values map 1:1; upstream `max` maps to `xhigh` (the closest
 * local level); anything unrecognized is dropped. Reasoning-known without
 * published controls degrades to toggle semantics (`default` + `auto`).
 * `default` is always first, matching the legacy convention.
 */
export function getExternalReasoningEffortOptions(
  model: Model | undefined | null,
  provider?: Provider | null
): ReasoningEffortOption[] | undefined {
  const entry = getExternalModelEntry(model, provider)
  if (!entry || entry.reasoning !== true) return undefined
  const known: ReasoningEffortOption[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'auto']
  const mapped: ReasoningEffortOption[] = []
  for (const value of entry.reasoningControls?.effort ?? []) {
    const normalized = value.trim().toLowerCase()
    const option: ReasoningEffortOption | undefined =
      normalized === 'max'
        ? 'xhigh'
        : known.includes(normalized as ReasoningEffortOption)
          ? (normalized as ReasoningEffortOption)
          : undefined
    if (option && !mapped.includes(option)) mapped.push(option)
  }
  if (mapped.length === 0) {
    return entry.reasoningControls?.toggle ? ['default', 'auto'] : ['default']
  }
  return ['default', ...mapped]
}

export interface ExternalModelPricing {
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion?: number
  cacheWritePerMillion?: number
  /** Distinguishes external enrichment from user-configured pricing. */
  source: 'models.dev'
}

/**
 * Pricing enrichment only: defined solely when the mapped entry publishes
 * numeric input+output pricing. Never claims a route price for an
 * unidentified host — unmapped providers return undefined.
 */
export function getExternalModelPricing(
  model: Model | undefined | null,
  provider?: Provider | null
): ExternalModelPricing | undefined {
  const entry = getExternalModelEntry(model, provider)
  const pricingFields = entry?.pricing
  const input = pricingFields?.input
  const output = pricingFields?.output
  if (typeof input !== 'number' || typeof output !== 'number') return undefined
  const pricing: ExternalModelPricing = { inputPerMillion: input, outputPerMillion: output, source: 'models.dev' }
  if (typeof pricingFields?.cacheRead === 'number') pricing.cacheReadPerMillion = pricingFields.cacheRead
  if (typeof pricingFields?.cacheWrite === 'number') pricing.cacheWritePerMillion = pricingFields.cacheWrite
  return pricing
}

export interface ExternalModelContext {
  contextLimit?: number
  outputLimit?: number
  family?: string
  knowledgeCutoff?: string
  releaseDate?: string
}

/** Context/family enrichment only; undefined when nothing is published. */
export function getExternalModelContext(
  model: Model | undefined | null,
  provider?: Provider | null
): ExternalModelContext | undefined {
  const entry = getExternalModelEntry(model, provider)
  if (!entry) return undefined
  const context: ExternalModelContext = {}
  if (typeof entry.limits?.context === 'number') context.contextLimit = entry.limits.context
  if (typeof entry.limits?.output === 'number') context.outputLimit = entry.limits.output
  if (typeof entry.family === 'string') context.family = entry.family
  if (typeof entry.knowledgeCutoff === 'string') context.knowledgeCutoff = entry.knowledgeCutoff
  if (typeof entry.releaseDate === 'string') context.releaseDate = entry.releaseDate
  return Object.keys(context).length > 0 ? context : undefined
}

/**
 * Shared priority helper for predicate wiring: user override first, then
 * external tri-state. Returns undefined when neither decides, letting the
 * caller fall through to its legacy heuristic.
 */
export function resolveCapabilityWithOverride(
  model: Model | undefined | null,
  type: 'vision' | 'reasoning' | 'function_calling',
  external: boolean | undefined
): boolean | undefined {
  if (!model) return undefined
  const override = isUserSelectedModelType(model, type)
  if (override !== undefined) return override
  return external
}
