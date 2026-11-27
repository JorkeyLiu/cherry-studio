/**
 * useChatContext never publishes selection to the runtime store.
 *
 * Message consumers (Messages container / MessageGroup / Message / MessageHeader)
 * only read multi-select state. The runtime `activeTopic` copy has a single owner
 * (HomePage), so mounting or rerendering any number of useChatContext instances —
 * even with fresh topic object references — must not dispatch `setActiveTopic`,
 * while the multi-select contract stays intact.
 */
import { configureStore } from '@reduxjs/toolkit'
import runtimeReducer from '@renderer/store/runtime'
import { act, render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { describe, expect, it, vi } from 'vitest'

import { useChatContext } from '../useChatContext'

type Any = any

const makeStore = () =>
  configureStore({
    reducer: { runtime: runtimeReducer } as Any,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false })
  })

const freshTopic = (id: string): Any => ({ id, name: id })

function Probe({ topic, capture }: { topic: Any; capture: (api: Any) => void }) {
  const api = useChatContext(topic)
  capture(api)
  return null
}

const RUNTIME_SYNC_TYPE = 'runtime/setActiveTopic'

function runtimeSyncCalls(dispatchMock: Any) {
  return dispatchMock.mock.calls.filter((call: Any[]) => call[0]?.type === RUNTIME_SYNC_TYPE)
}

describe('useChatContext runtime isolation', () => {
  it('multiple instances mounting and rerendering with fresh topic refs never dispatch runtime setActiveTopic', () => {
    const store = makeStore()
    const dispatchSpy = vi.spyOn(store, 'dispatch')

    const { rerender } = render(
      <Provider store={store}>
        <Probe topic={freshTopic('topic-A')} capture={() => {}} />
        <Probe topic={freshTopic('topic-A')} capture={() => {}} />
        <Probe topic={freshTopic('topic-B')} capture={() => {}} />
      </Provider>
    )

    // Rerender every consumer with brand-new object references (the exact
    // pattern that used to fan out one runtime dispatch per consumer).
    rerender(
      <Provider store={store}>
        <Probe topic={freshTopic('topic-A')} capture={() => {}} />
        <Probe topic={freshTopic('topic-A')} capture={() => {}} />
        <Probe topic={freshTopic('topic-B')} capture={() => {}} />
      </Provider>
    )
    rerender(
      <Provider store={store}>
        <Probe topic={freshTopic('topic-B')} capture={() => {}} />
        <Probe topic={freshTopic('topic-A')} capture={() => {}} />
        <Probe topic={freshTopic('topic-A')} capture={() => {}} />
      </Provider>
    )

    expect(runtimeSyncCalls(dispatchSpy)).toEqual([])
    expect(store.getState().runtime.chat.activeTopic).toBeNull()
  })

  it('keeps the multi-select contract and activeTopic passthrough without syncing', () => {
    const store = makeStore()
    const dispatchSpy = vi.spyOn(store, 'dispatch')
    let api: Any = null
    const topic = freshTopic('topic-A')

    render(
      <Provider store={store}>
        <Probe topic={topic} capture={(captured) => (api = captured)} />
      </Provider>
    )

    // Passthrough: the caller-owned topic object is returned as-is.
    expect(api.activeTopic).toBe(topic)

    act(() => {
      api.toggleMultiSelectMode(true)
    })
    expect(store.getState().runtime.chat.isMultiSelectMode).toBe(true)

    act(() => {
      api.handleSelectMessage('m1', true)
    })
    expect(store.getState().runtime.chat.selectedMessageIds).toEqual(['m1'])

    act(() => {
      api.handleSelectMessage('m1', false)
    })
    expect(store.getState().runtime.chat.selectedMessageIds).toEqual([])

    // Multi-select actions flow; selection sync never does.
    expect(runtimeSyncCalls(dispatchSpy)).toEqual([])
    expect(store.getState().runtime.chat.activeTopic).toBeNull()
  })
})
