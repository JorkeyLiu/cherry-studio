import {
  resolveCanonicalModelEntry,
  resolveProviderForMetadata,
  resolveServingEffortForModel,
  resolveServingModelForModel
} from '@renderer/services/modelMetadata'
import type { Model, Provider } from '@renderer/types'
import { isUserSelectedModelType } from '@renderer/utils'
import type { NormalizedModelMetadata, NormalizedProviderServingModel } from '@shared/modelMetadata'

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

/** Exact provider-serving metadata entry (api.json, owning provider + exact serving id), or undefined. */
export function getServingModelEntry(
  model: Model | undefined | null,
  provider?: Provider | null
): NormalizedProviderServingModel | undefined {
  return resolveServingModelForModel(model, provider === undefined ? undefined : provider)
}

export interface ModelMetadataDisplaySources {
  /** Canonical entry from models.json (lab standard facts). */
  canonical?: NormalizedModelMetadata
  /** Exact serving entry from api.json (provider-specific display facts). Never merged into canonical. */
  serving?: NormalizedProviderServingModel
  /** Effective merged view for display: serving fields win, canonical fills only missing fields. */
  effective?: NormalizedModelMetadata & {
    description?: string
    cost?: NormalizedProviderServingModel['cost']
    effort?: string[]
  }
  /** Which source contributed at least one field to the effective view. */
  source: 'serving' | 'canonical' | 'mixed' | 'none'
}

/**
 * Display-priority metadata for the Edit Model UI: exact serving entry wins,
 * canonical fills only fields absent from serving (and never overwrites
 * serving). The two sources are kept distinct; the caller must not treat them
 * as one identity. For unknown ids both are undefined and effective is absent.
 */
export function getModelMetadataForDisplay(
  model: Model | undefined | null,
  provider?: Provider | null
): ModelMetadataDisplaySources {
  const canonical = getExternalModelEntry(model, provider)
  const serving = getServingModelEntry(model, provider)
  if (!canonical && !serving) return { source: 'none' }
  if (serving && !canonical) {
    const eff: ModelMetadataDisplaySources['effective'] = {
      id: serving.id ?? model?.id ?? '',
      modalities: serving.modalities ?? { input: [], output: [] },
      ...(serving.name !== undefined ? { name: serving.name } : {}),
      ...(serving.family !== undefined ? { family: serving.family } : {}),
      ...(serving.knowledgeCutoff !== undefined ? { knowledgeCutoff: serving.knowledgeCutoff } : {}),
      ...(serving.releaseDate !== undefined ? { releaseDate: serving.releaseDate } : {}),
      ...(serving.lastUpdated !== undefined ? { lastUpdated: serving.lastUpdated } : {}),
      ...(serving.attachment !== undefined ? { attachment: serving.attachment } : {}),
      ...(serving.toolCall !== undefined ? { toolCall: serving.toolCall } : {}),
      ...(serving.structuredOutput !== undefined ? { structuredOutput: serving.structuredOutput } : {}),
      ...(serving.temperature !== undefined ? { temperature: serving.temperature } : {}),
      ...(serving.reasoning !== undefined ? { reasoning: serving.reasoning } : {}),
      ...(serving.limits !== undefined ? { limits: serving.limits } : {}),
      ...(serving.description !== undefined ? { description: serving.description } : {}),
      ...(serving.cost !== undefined ? { cost: serving.cost } : {}),
      ...(serving.effort !== undefined ? { effort: serving.effort } : {})
    }
    return { serving, canonical, effective: eff, source: 'serving' }
  }
  if (canonical && !serving) {
    return { canonical, serving, effective: canonical as ModelMetadataDisplaySources['effective'], source: 'canonical' }
  }
  // both present: serving wins, canonical fills gaps
  const eff: ModelMetadataDisplaySources['effective'] = {
    id: serving!.id ?? canonical!.id,
    modalities:
      serving!.modalities && (serving!.modalities.input.length > 0 || serving!.modalities.output.length > 0)
        ? serving!.modalities
        : canonical!.modalities,
    name: serving!.name ?? canonical!.name,
    family: serving!.family ?? canonical!.family,
    knowledgeCutoff: serving!.knowledgeCutoff ?? canonical!.knowledgeCutoff,
    releaseDate: serving!.releaseDate ?? canonical!.releaseDate,
    lastUpdated: serving!.lastUpdated ?? canonical!.lastUpdated,
    attachment: serving!.attachment ?? canonical!.attachment,
    toolCall: serving!.toolCall ?? canonical!.toolCall,
    structuredOutput: serving!.structuredOutput ?? canonical!.structuredOutput,
    temperature: serving!.temperature ?? canonical!.temperature,
    reasoning: serving!.reasoning ?? canonical!.reasoning,
    limits: serving!.limits ?? canonical!.limits,
    description: serving!.description,
    cost: serving!.cost,
    effort: serving!.effort
  }
  // Reliable rule: if serving exists and contributes any field to the effective
  // view (any of its own keys !== undefined), the honest source is 'mixed'.
  // This includes provider-specific display-only fields (description/cost/effort).
  const hasServingField =
    serving!.id !== undefined ||
    serving!.name !== undefined ||
    serving!.description !== undefined ||
    serving!.family !== undefined ||
    serving!.knowledgeCutoff !== undefined ||
    serving!.releaseDate !== undefined ||
    serving!.lastUpdated !== undefined ||
    serving!.modalities !== undefined ||
    serving!.attachment !== undefined ||
    serving!.toolCall !== undefined ||
    serving!.structuredOutput !== undefined ||
    serving!.temperature !== undefined ||
    serving!.reasoning !== undefined ||
    serving!.limits !== undefined ||
    serving!.cost !== undefined ||
    serving!.effort !== undefined
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
