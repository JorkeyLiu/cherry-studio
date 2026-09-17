import type { Model, Provider, ProviderType } from '@renderer/types'
import { assertProviderMatchesModel } from '@renderer/utils/noModelError'

/**
 * Custom-connection provider registry (slice 1).
 *
 * Product direction: custom connections are the only bootstrap/new-connection
 * path and ultimately only the OpenAI, Anthropic, and Gemini protocol adapters
 * remain. This module owns the narrow, catalog-free resolution contract for
 * that path:
 *
 * - New connections may only be created for the three approved protocols
 *   (OpenAI-compatible, Anthropic, Gemini).
 * - Basic request resolution for those protocols never consults external model
 *   metadata/catalogs: a manually configured or renamed model id resolves as
 *   long as its owning provider entry exists. Unknown ids get basic protocol
 *   behavior (capability helpers default to false), never a resolution failure.
 * - Stale provider-id mismatch protection is preserved: a resolved provider
 *   whose id does not equal the model's own provider id is rejected with the
 *   same NoModelError path as an unconfigured slot. There is no fallback to
 *   another (e.g. default) provider.
 *
 * Legacy runtime adapters (Bedrock/Vertex/Azure/Copilot OAuth and the other
 * historical provider types) are intentionally NOT removed in this slice: they
 * may still be present in persisted state so existing references are not
 * orphaned. A later slice retires their execution.
 */

/** Protocols offered for new custom connections. */
export const CUSTOM_CREATABLE_PROTOCOLS = ['openai', 'anthropic', 'gemini'] as const satisfies readonly ProviderType[]

export type CustomCreatableProtocol = (typeof CUSTOM_CREATABLE_PROTOCOLS)[number]

/**
 * Provider types treated as OpenAI/Anthropic/Gemini-compatible for migration
 * preservation. `ollama` and `new-api` speak the OpenAI-compatible protocol
 * (and were previously offered for new connections), so existing entries are
 * preserved as ordinary user providers. `openai-response` is the OpenAI
 * Responses-API variant of the same protocol family.
 */
const PRESERVED_COMPATIBLE_TYPES: readonly string[] = [
  'openai',
  'openai-response',
  'anthropic',
  'gemini',
  'ollama',
  'new-api'
]

export function isCustomCreatableProtocol(type: string): type is CustomCreatableProtocol {
  return (CUSTOM_CREATABLE_PROTOCOLS as readonly string[]).includes(type)
}

/**_Preserved-compatibility check used by the persisted-state migration. */
export function isPreservedCompatibleProtocol(type: string): boolean {
  return PRESERVED_COMPATIBLE_TYPES.includes(type)
}

/**
 * Catalog-free provider resolution for a requested model.
 *
 * Looks up the owning provider by id only — never by external metadata,
 * catalog, or SYSTEM_MODELS — then enforces the stale provider-id match.
 * Unknown manually added model ids resolve exactly like known ids.
 *
 * @throws NoModelError when the model is missing, its provider cannot be
 * found, or the resolved provider does not belong to the requested model.
 */
export function resolveCustomProviderForModel(model: Model | undefined, providers: Provider[]): Provider {
  const provider = providers.find((p) => p.id === model?.provider)
  assertProviderMatchesModel(model as Model, provider)
  return provider
}

/**
 * Normalizes the protocol type resulting from an add/edit dialog interaction.
 *
 * New creation only offers the approved protocols, so an edited result is
 * accepted as-is when the original type is itself creatable. A retained
 * legacy entry (unsupported protocol) keeps its original type regardless of
 * popup interaction — the dialog must never blank or rewrite it. The UI
 * additionally renders the protocol field read-only for such entries.
 */
export function normalizeEditedProviderType(originalType: ProviderType, editedType: ProviderType): ProviderType {
  return isCustomCreatableProtocol(originalType) ? editedType : originalType
}
