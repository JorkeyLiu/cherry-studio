import type { Model, Provider } from '@renderer/types'
import { objectEntries } from '@renderer/types'
import { type InputModalityFilter, supportsInputModality } from '@renderer/utils/inputModalities'
import { useCallback, useMemo, useState } from 'react'

type ModelPredict = (m: Model, provider?: Provider | null) => boolean

const initialTagSelection: Record<InputModalityFilter, boolean> = {
  text: false,
  image: false,
  audio: false,
  video: false,
  pdf: false
}

/**
 * Input-modality filter hook (unit A).
 *
 * Replaces the retired vision/reasoning/tool/embedding/rerank/free tag
 * filter with the five precise models.dev input modalities. The vocabulary
 * is the local display-only `InputModalityFilter` — persisted
 * `ModelTag`/`ModelType` keys are untouched. Predicates are exact-only:
 * unknown entries never match, and callers with an owning provider pass it
 * for precise attribution (otherwise `strictProviderForModel` applies).
 */
export function useModelTagFilter() {
  const filterConfig: Record<InputModalityFilter, ModelPredict> = useMemo(
    () => ({
      text: (m, p) => supportsInputModality(m, 'text', p),
      image: (m, p) => supportsInputModality(m, 'image', p),
      audio: (m, p) => supportsInputModality(m, 'audio', p),
      video: (m, p) => supportsInputModality(m, 'video', p),
      pdf: (m, p) => supportsInputModality(m, 'pdf', p)
    }),
    []
  )

  const [tagSelection, setTagSelection] = useState<Record<InputModalityFilter, boolean>>(initialTagSelection)

  // 已选中的模态
  const selectedTags = useMemo(
    () =>
      objectEntries(tagSelection)
        .filter(([, state]) => state)
        .map(([tag]) => tag),
    [tagSelection]
  )

  // 切换模态
  const toggleTag = useCallback((tag: InputModalityFilter) => {
    setTagSelection((prev) => ({ ...prev, [tag]: !prev[tag] }))
  }, [])

  // 重置模态
  const resetTags = useCallback(() => {
    setTagSelection(initialTagSelection)
  }, [])

  // 根据模态过滤模型（AND 语义；无选中时全过）
  const tagFilter = useCallback(
    (model: Model, provider?: Provider | null) => {
      if (selectedTags.length === 0) return true
      return selectedTags.map((tag) => filterConfig[tag]).every((predict) => predict(model, provider))
    },
    [filterConfig, selectedTags]
  )

  return {
    tagSelection,
    selectedTags,
    tagFilter,
    toggleTag,
    resetTags
  }
}
