import type { AdaptedApiModel, ApiModel, Model, ModelTag } from '@renderer/types'

/**
 * Legacy display-tag availability (compat shim, unit A).
 *
 * The compact display/filter layer no longer uses vision / reasoning /
 * tool / embedding / rerank / free tags: it shows only the five precise
 * models.dev input modalities (see `@renderer/utils/inputModalities`).
 * This function is retained solely so the persisted `ModelTag`/`ModelType`
 * keys keep their shape (no deletion, no migration): it always reports all
 * false and no display caller should depend on it. New code must use
 * `getInputModalityAvailability` / `getInputModalityAvailabilityFromProviders`.
 */
export const getModelTags = (_models: Model[]): Record<ModelTag, boolean> => {
  const result: Record<ModelTag, boolean> = {
    vision: false,
    embedding: false,
    reasoning: false,
    function_calling: false,
    web_search: false,
    rerank: false,
    free: false
  }
  void _models
  return result
}

export function isFreeModel(model: Model) {
  return (model.id + model.name).toLocaleLowerCase().includes('free')
}

export const getDuplicateModelNames = <T extends Pick<Model, 'name'>>(models: T[]): Set<string> => {
  const nameCounts = new Map<string, number>()

  for (const model of models) {
    nameCounts.set(model.name, (nameCounts.get(model.name) ?? 0) + 1)
  }

  const duplicateNames = new Set<string>()

  for (const [name, count] of nameCounts.entries()) {
    if (count > 1) {
      duplicateNames.add(name)
    }
  }

  return duplicateNames
}

export const apiModelAdapter = (model: ApiModel): AdaptedApiModel => {
  return {
    id: model.provider_model_id ?? model.id,
    provider: model.provider ?? '',
    name: model.name,
    group: '',
    origin: model
  }
}
