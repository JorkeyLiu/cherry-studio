import i18n from '@renderer/i18n'
import type { Model, Provider } from '@renderer/types'

/**
 * Stable, non-localized marker for the no-model error category. Both the
 * factory below and errorClassifier match on this name so classification stays
 * locale-independent instead of comparing the translated message.
 */
export const NO_MODEL_ERROR_NAME = 'NoModelError'

/**
 * Local no-model error thrown before any provider/API/network access when the
 * model slot is unconfigured or its provider cannot be resolved (including the
 * stale-provider case where the resolved provider does not belong to the
 * requested model). The message keeps the existing localized
 * `message.error.enter.model` text; the `name` marker drives classification.
 */
export function createNoModelError(): Error {
  const error = new Error(i18n.t('message.error.enter.model'))
  error.name = NO_MODEL_ERROR_NAME
  return error
}

export function isNoModelError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === NO_MODEL_ERROR_NAME
}

/**
 * Verifies that a resolved provider actually belongs to the requested model.
 *
 * `getProviderByModel` may fall back to the global default provider when the
 * assistant's model is stale (its provider is no longer in the store). That
 * silent substitution is intentionally rejected here: the stale model emits
 * the same NoModelError recovery path as an unconfigured slot. Only a provider
 * whose id matches the model's own provider id is accepted.
 */
export function assertProviderMatchesModel(model: Model, provider: Provider | undefined): asserts provider is Provider {
  if (!provider || provider.id !== model.provider) {
    throw createNoModelError()
  }
}
