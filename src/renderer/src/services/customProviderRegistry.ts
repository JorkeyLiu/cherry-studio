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
 * Endpoint modes under the OpenAI-compatible protocol.
 * `openai` is Chat Completions, `openai-response` is Responses.
 * Runtime paths remain separate; this only groups the creation/edit UI.
 */
export const OPENAI_COMPATIBLE_ENDPOINT_MODES = ['openai', 'openai-response'] as const satisfies readonly ProviderType[]

export type OpenAICompatibleEndpointMode = (typeof OPENAI_COMPATIBLE_ENDPOINT_MODES)[number]

export function isOpenAICompatibleEndpointType(type: string): type is OpenAICompatibleEndpointMode {
  return (OPENAI_COMPATIBLE_ENDPOINT_MODES as readonly string[]).includes(type)
}

/**
 * Top-level protocol shown in the Add/Edit dialog for a stored type.
 * Both OpenAI-compatible endpoint modes collapse to the `openai` protocol.
 */
export function getCreatableProtocolForProviderType(type: ProviderType): CustomCreatableProtocol | ProviderType {
  if (isOpenAICompatibleEndpointType(type)) {
    return 'openai'
  }
  return type
}

/**
 * Endpoint mode for a stored type. Defaults to Chat Completions (`openai`)
 * when the type is not an OpenAI-compatible endpoint mode.
 */
export function getEndpointModeForProviderType(type: ProviderType | undefined): OpenAICompatibleEndpointMode {
  if (type !== undefined && isOpenAICompatibleEndpointType(type)) {
    return type
  }
  return 'openai'
}

/**
 * Maps the dialog protocol + endpoint-mode selection to a stored provider type.
 * Only the OpenAI-compatible protocol consults the endpoint mode; all other
 * protocols map 1:1 and runtime paths stay separate.
 */
export function resolveProviderTypeForProtocol(
  protocol: CustomCreatableProtocol | ProviderType,
  endpointMode: OpenAICompatibleEndpointMode
): ProviderType {
  if (protocol === 'openai') {
    return endpointMode
  }
  return protocol as ProviderType
}

/**
 * Whether a stored type is editable in the Add/Edit dialog.
 * Approved protocols plus the Responses endpoint mode are editable;
 * retained legacy types (ollama, new-api, azure-*, ...) stay read-only.
 */
export function isEditableCustomProviderType(type: string): boolean {
  return isCustomCreatableProtocol(type) || type === 'openai-response'
}

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
 * accepted as-is when the original type is itself editable. That includes
 * the Responses endpoint mode (`openai-response`), which is edited through
 * the OpenAI-compatible protocol and may switch to/from Chat Completions
 * (`openai`). A retained legacy entry (unsupported protocol) keeps its
 * original type regardless of popup interaction — the dialog must never
 * blank or rewrite it. The UI additionally renders the protocol field
 * read-only for such entries.
 */
export function normalizeEditedProviderType(originalType: ProviderType, editedType: ProviderType): ProviderType {
  return isEditableCustomProviderType(originalType) ? editedType : originalType
}
