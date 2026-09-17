import type { Model, Provider } from '@renderer/types'

/**
 * Cycle-free exact owning-provider resolver.
 *
 * `config/models` capability modules must stay pure: they never import
 * AssistantService or the store/data-source chain (that edge created a
 * deterministic collection-time TDZ through store/assistants ->
 * SqliteMessageDataSource). This registry holds a synchronously-injected
 * lookup instead.
 *
 * Contract:
 * - exact `model.provider` id match only, never a default fallback;
 * - unregistered / throwing / mismatched resolvers degrade to null;
 * - synchronous because capability predicates are synchronous;
 * - registered once from a safe boot seam after store construction
 *   (renderer init), never from AssistantService (no back-edge).
 */
export type ExactProviderResolver = (model: Model | undefined | null) => Provider | null | undefined

let resolver: ExactProviderResolver | null = null

export function setExactProviderResolver(next: ExactProviderResolver | null): void {
  resolver = next
}

export function resolveExactProvider(model: Model | undefined | null): Provider | null {
  if (!model || typeof model.provider !== 'string' || model.provider.length === 0) return null
  try {
    const provider = resolver?.(model)
    return provider && provider.id === model.provider ? provider : null
  } catch {
    return null
  }
}
