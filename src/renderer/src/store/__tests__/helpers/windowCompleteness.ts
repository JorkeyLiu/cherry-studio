/**
 * Test support for the resident-registry window-boundary projection state.
 *
 * There is no test-only writer and no test-only global map: priming establishes
 * the metadata exactly as production does — `bumpGeneration` then
 * `publishResidentComplete` on the store under test — and verification reads
 * the real selector. The publication re-uses the messages/segments the state
 * already holds, so priming contributes only the resident-registry entry and
 * its boundary metadata (the joint publication is what establishes both).
 */
import store from '@renderer/store'
import {
  bumpGeneration,
  publishResidentComplete,
  selectTopicWindowCompleteness
} from '@renderer/store/residentRegistry'
import type { FetchMessagesWindowResponse } from '@shared/chatDb'

type StoreLike = {
  dispatch: (action: any) => any
  getState: () => any
}

export interface WindowBoundary {
  hasMoreBefore: boolean
  hasMoreAfter: boolean
}

const defaultStore: StoreLike = store

/** Real selector read; `undefined` = no window publication retained for this topic. */
export function selectWindowBoundary(topicId: string, target: StoreLike = defaultStore): WindowBoundary | undefined {
  return selectTopicWindowCompleteness(target.getState(), topicId)
}

/**
 * Establish the topic's retained window boundary through the single production
 * publication path, and return the generation it was published under.
 */
export function primeWindowBoundary(
  topicId: string,
  boundary: WindowBoundary,
  target: StoreLike = defaultStore
): number {
  const state = target.getState() ?? {}
  const ids: string[] = state?.messages?.messageIdsByTopic?.[topicId] ?? []
  const entities = state?.messages?.entities ?? {}
  const messages = ids.map((id) => entities[id] ?? { id, topicId, blocks: [] })
  const segmentIds: string[] = state?.topicSegments?.segmentsByTopic?.[topicId] ?? []
  const segmentEntities = state?.topicSegments?.segments?.entities ?? {}
  const segments = segmentIds.map((id) => segmentEntities[id]).filter(Boolean)
  target.dispatch(bumpGeneration(topicId))
  const generation = (target.getState()?.residentRegistry?.entries?.[topicId]?.applicabilityGeneration ?? 0) as number
  const windowResponse = {
    messages,
    blocks: [],
    window: {
      kind: 'latest' as const,
      completeness: 'window' as const,
      topicId,
      anchorMessageId: null,
      requested: { limit: Math.min(100, Math.max(1, messages.length)) },
      firstMessageId: messages.length > 0 ? messages[0].id : null,
      lastMessageId: messages.length > 0 ? messages[messages.length - 1].id : null,
      returnedCount: messages.length,
      hasMoreBefore: boundary.hasMoreBefore,
      hasMoreAfter: boundary.hasMoreAfter
    }
  } as unknown as FetchMessagesWindowResponse
  target.dispatch(publishResidentComplete({ topicId, generation, windowResponse, segments }))
  return generation
}
