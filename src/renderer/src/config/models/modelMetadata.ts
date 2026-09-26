import {
  getModelMetadataSnapshot,
  resolveCanonicalModelEntry,
  resolveProviderForMetadata,
  resolveReferenceServingForModel,
  resolveServingEffortForModel,
  resolveServingModelForModel
} from '@renderer/services/modelMetadata'
import type { Model, Provider } from '@renderer/types'
import { isUserSelectedModelType } from '@renderer/utils'
import {
  type NormalizedModelMetadata,
  type NormalizedProviderServingModel,
  resolveCanonicalModel,
  resolveReferenceServingModel
} from '@shared/modelMetadata'

/**
 * Tri-state capability resolvers over the optional canonical models.dev
 * registry (`models.json`).
 *
 * This module is intentionally pure: it never imports AssistantService or
 * the store/data-source chain (that edge caused a deterministic
 * collection-time TDZ). Request-lane provider resolution flows through the
 * injected `resolveProviderForMetadata` accessor instead.
 *
 * Model identity is canonical only: entries resolve by model id through the
 * shared canonical matching contract (exact id -> unique basename -> unique
 * case-fold, fail closed). Identity never uses the API URL, `group`,
 * editable `name`, provider brand id, or `owned_by`, so the same proxy model
 * id reports the same standard capability on every connection. The optional
 * `provider` argument is accepted for call-site compatibility but never
 * participates in resolution.
 *
 * Priority everywhere: explicit user override
 * (`capabilities[].isUserSelected`) -> validated canonical metadata -> legacy
 * heuristic fallback (owned by the existing predicates, untouched here).
 *
 * Every resolver returns true/false only for validated known values and
 * undefined for unknown (absent snapshot, unmapped/ambiguous model id, or
 * absent upstream field). Unknown must never harden into a rejection:
 * callers fall through to the legacy heuristic and unknown ids still reach
 * request resolution.
 *
 * Canonical `models.json` publishes no provider-specific pricing or
 * reasoning options: those UI fields read as unknown/absent (no
 * proxy-serving record is ever filled in as a canonical fact).
 */

/**
 * Strict owning-provider lookup for request-lane attribution.
 *
 * Attribution requires the exact owning provider: a resolver result whose id
 * does not equal the model's own provider id is treated as unknown (this
 * also neutralizes any silent default-provider substitution). An explicit
 * provider argument (including explicit null = known absent) bypasses the
 * accessor. Capability facts never use this function.
 */
export function strictProviderForModel(model: Model | undefined | null, explicit?: Provider | null): Provider | null {
  return resolveProviderForMetadata(model, explicit)
}

/** Canonical external entry for a model id, or undefined when unknown/ambiguous. */
export function getExternalModelEntry(
  model: Model | undefined | null,
  _provider?: Provider | null
): NormalizedModelMetadata | undefined {
  if (!model || typeof model.id !== 'string') return undefined
  return resolveCanonicalModelEntry(model.id)
}

/** Request-lane exact provider-serving entry (owning provider + exact serving id), or undefined. Edit display never uses this. */
export function getServingModelEntry(
  model: Model | undefined | null,
  provider?: Provider | null
): NormalizedProviderServingModel | undefined {
  return resolveServingModelForModel(model, provider === undefined ? undefined : provider)
}

/**
 * Model-centric reference serving entry for Edit Model display: the serving
 * record inside `snapshot.providers[canonicalLab]` resolved after canonical,
 * independent of the user's provider/API host. Returns undefined when
 * canonical is unknown or the reference lookup misses. Never affects requests.
 */
export function getReferenceServingEntry(model: Model | undefined | null): NormalizedProviderServingModel | undefined {
  return resolveReferenceServingForModel(model)
}

export interface ModelMetadataDisplaySources {
  /** Canonical entry from models.json (lab standard facts). */
  canonical?: NormalizedModelMetadata
  /**
   * Model-centric reference serving entry from api.json
   * (`snapshot.providers[canonicalLab]`; display-only reference facts such as
   * cost/limits/effort). Never merged into canonical, never request identity.
   * Kept under the `serving` key for call-site compatibility.
   */
  serving?: NormalizedProviderServingModel
  /** Effective merged view for display: canonical-lab reference serving fields win, canonical fills only missing fields. */
  effective?: NormalizedModelMetadata & {
    description?: string
    cost?: NormalizedProviderServingModel['cost']
    effort?: string[]
  }
  /** Which source contributed at least one field to the effective view. */
  source: 'canonical' | 'mixed' | 'none'
}

/**
 * Model-centric display metadata for the Edit Model UI: canonical resolves
 * first (shared contract, unchanged), then a display-only reference serving
 * entry resolves inside `snapshot.providers[canonicalLab]` only — never from
 * the user's provider/API host. Reference serving fields win, canonical fills
 * only missing fields; the two sources stay distinct and never gate or rewrite
 * requests. The optional `provider` argument remains for call-site
 * compatibility but never controls the result.
 */
export function getModelMetadataForDisplay(
  model: Model | undefined | null,
  _provider?: Provider | null
): ModelMetadataDisplaySources {
  void _provider
  if (!model || typeof model.id !== 'string') return { source: 'none' }
  const snapshot = getModelMetadataSnapshot()
  const resolved = resolveCanonicalModel(model.id, snapshot)
  if (!resolved) return { source: 'none' }
  const canonical = resolved.entry
  const serving = resolveReferenceServingModel(resolved.canonicalId, snapshot, canonical.name)
  if (!serving) {
    return { canonical, serving, effective: canonical as ModelMetadataDisplaySources['effective'], source: 'canonical' }
  }
  // Both present: canonical-lab reference serving wins, canonical fills gaps.
  // Cost, limits, and effort can appear from the reference entry;
  // capabilities/modalities stay reference metadata about the resolved model,
  // never the user's connection.
  const eff: ModelMetadataDisplaySources['effective'] = {
    id: serving.id ?? canonical.id,
    modalities:
      serving.modalities && (serving.modalities.input.length > 0 || serving.modalities.output.length > 0)
        ? serving.modalities
        : canonical.modalities,
    name: serving.name ?? canonical.name,
    family: serving.family ?? canonical.family,
    knowledgeCutoff: serving.knowledgeCutoff ?? canonical.knowledgeCutoff,
    releaseDate: serving.releaseDate ?? canonical.releaseDate,
    lastUpdated: serving.lastUpdated ?? canonical.lastUpdated,
    attachment: serving.attachment ?? canonical.attachment,
    toolCall: serving.toolCall ?? canonical.toolCall,
    structuredOutput: serving.structuredOutput ?? canonical.structuredOutput,
    temperature: serving.temperature ?? canonical.temperature,
    reasoning: serving.reasoning ?? canonical.reasoning,
    limits: serving.limits ?? canonical.limits,
    description: serving.description,
    cost: serving.cost,
    effort: serving.effort
  }
  // Reliable rule: if the reference entry contributes any field to the
  // effective view (any of its own keys !== undefined), the honest source is
  // 'mixed'. This includes reference-only display fields
  // (description/cost/effort).
  const hasServingField =
    serving.id !== undefined ||
    serving.name !== undefined ||
    serving.description !== undefined ||
    serving.family !== undefined ||
    serving.knowledgeCutoff !== undefined ||
    serving.releaseDate !== undefined ||
    serving.lastUpdated !== undefined ||
    serving.modalities !== undefined ||
    serving.attachment !== undefined ||
    serving.toolCall !== undefined ||
    serving.structuredOutput !== undefined ||
    serving.temperature !== undefined ||
    serving.reasoning !== undefined ||
    serving.limits !== undefined ||
    serving.cost !== undefined ||
    serving.effort !== undefined
  const source: ModelMetadataDisplaySources['source'] = hasServingField ? 'mixed' : 'canonical'
  return { serving, canonical, effective: eff, source }
}

/**
 * Vision support from canonical metadata: `modalities.input includes image`.
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

/** Tool-calling support from canonical `tool_call` (absent means unknown). */
export function resolveExternalToolCallSupport(
  model: Model | undefined | null,
  provider?: Provider | null
): boolean | undefined {
  const entry = getExternalModelEntry(model, provider)
  if (!entry || entry.toolCall === undefined) return undefined
  return entry.toolCall
}

/** Reasoning support from canonical `reasoning` (absent means unknown). */
export function resolveExternalReasoningSupport(
  model: Model | undefined | null,
  provider?: Provider | null
): boolean | undefined {
  const entry = getExternalModelEntry(model, provider)
  if (!entry || entry.reasoning === undefined) return undefined
  return entry.reasoning
}

/** Provider-specific serving effort values (`reasoning_options` type `effort`), normalized (`max` -> `xhigh`). */
export function resolveServingReasoningEffort(
  model: Model | undefined | null,
  provider?: Provider | null
): string[] | undefined {
  // Preserve explicit null (known absent) vs undefined (auto-resolve via exact provider).
  return resolveServingEffortForModel(model, provider === undefined ? undefined : provider)
}

/** Temperature support from canonical `temperature` (absent means unknown). */
export function resolveExternalTemperatureSupport(
  model: Model | undefined | null,
  provider?: Provider | null
): boolean | undefined {
  const entry = getExternalModelEntry(model, provider)
  if (!entry || entry.temperature === undefined) return undefined
  return entry.temperature
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
