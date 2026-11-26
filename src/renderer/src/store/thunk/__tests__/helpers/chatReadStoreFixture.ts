/**
 * Minimal real-reducer store fixture for the topic read path.
 *
 * `loadTopicMessagesThunk` reads and publishes through four slices — `messages`,
 * `messageBlocks`, `topicSegments` and `residentRegistry` — and its joint
 * publication is guarded by the production `shouldDiscardJointPublish` check.
 * This fixture wires exactly those slices plus that guard, so read-path tests
 * never hand-roll a registry/entry shape that the real reducers could drift
 * away from.
 *
 * Deliberately excluded: persistence middleware, StoreSync middleware, app
 * lifecycle wiring and every other root slice. The fixture is only the read-path
 * substrate, not a full application store.
 *
 * The `assistants` slice is a read-only lookup table (topic ownership) that the
 * read path only ever reads, so it is a plain overlay instead of a reducer;
 * `setAssistants` replaces it per case.
 */
import { combineReducers, configureStore } from '@reduxjs/toolkit'
import messageBlocksReducer from '@renderer/store/messageBlock'
import newMessagesReducer, { newMessagesActions } from '@renderer/store/newMessage'
import residentRegistryReducer, {
  bumpGeneration,
  JOINT_PUBLISH_COMPLETE,
  publishResidentComplete,
  shouldDiscardJointPublish
} from '@renderer/store/residentRegistry'
import topicSegmentReducer from '@renderer/store/topicSegment'

export interface FixtureAssistant {
  id: string
  prompt?: string
  settings?: Record<string, unknown>
  topics?: Array<{ id: string }>
}

export type FixtureMessage = Record<string, unknown> & { id: string }

const slices = combineReducers({
  messages: newMessagesReducer,
  messageBlocks: messageBlocksReducer,
  topicSegments: topicSegmentReducer,
  residentRegistry: residentRegistryReducer
})

export type ChatReadSlices = ReturnType<typeof slices>

/**
 * Production root-reducer semantics for the joint publication: a stale or
 * missing entry is discarded as a whole (no slice sees the action).
 */
const guardedSlices = (state: ChatReadSlices | undefined, action: { type?: string; payload?: unknown }) => {
  if (action?.type === JOINT_PUBLISH_COMPLETE && shouldDiscardJointPublish(state, action.payload)) {
    return state as ChatReadSlices
  }
  return slices(state, action as never)
}

function makeWindowResponse(topicId: string, messages: FixtureMessage[]) {
  const ids = messages.map((m) => m.id)
  return {
    messages,
    blocks: [],
    window: {
      kind: 'latest' as const,
      completeness: 'window' as const,
      topicId,
      anchorMessageId: null,
      requested: { limit: Math.max(ids.length, 1) },
      firstMessageId: ids[0] ?? null,
      lastMessageId: ids[ids.length - 1] ?? null,
      returnedCount: ids.length,
      hasMoreBefore: false,
      hasMoreAfter: false
    }
  }
}

export function createChatReadFixture(assistants: FixtureAssistant[]) {
  let assistantList = assistants
  const store = configureStore({
    reducer: guardedSlices,
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: false,
        immutableCheck: false
      })
  })

  /**
   * Real cache-hit precondition: the topic went through the real joint
   * publication (initial generation bump, then the guarded publish), so both the
   * projection and the complete resident entry exist.
   */
  function seedResidentComplete(topicId: string, messages: FixtureMessage[]) {
    const generation = (store.getState().residentRegistry.entries[topicId]?.applicabilityGeneration ?? 0) + 1
    store.dispatch(bumpGeneration(topicId))
    store.dispatch(
      publishResidentComplete({
        topicId,
        generation,
        windowResponse: makeWindowResponse(topicId, messages) as never,
        segments: [],
        route: null
      })
    )
  }

  /**
   * Index present but nothing resident (a cold projection, not a cache hit).
   */
  function seedCachedIndexOnly(topicId: string, messages: FixtureMessage[]) {
    store.dispatch(newMessagesActions.messagesReceived({ topicId, messages } as never))
  }

  return {
    store,
    dispatch: store.dispatch,
    /** RootState-compatible read view: real slices plus the static assistants overlay. */
    getState: () => ({ ...store.getState(), assistants: { assistants: assistantList } }),
    setAssistants(next: FixtureAssistant[]) {
      assistantList = next
    },
    seedResidentComplete,
    seedCachedIndexOnly
  }
}

export type ChatReadFixture = ReturnType<typeof createChatReadFixture>
