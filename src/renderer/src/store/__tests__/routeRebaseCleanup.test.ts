import { describe, expect, it } from 'vitest'

import { rootReducer } from '../index'
import { messageBlocksSlice } from '../messageBlock'
import { newMessagesActions } from '../newMessage'

const appReducer: any = rootReducer

function msg(id: string, blocks: string[] = []): any {
  return { id, topicId: 't1', role: 'user', content: id, status: 'success', blocks }
}
function block(id: string, messageId: string): any {
  return { id, messageId, type: 'main_text', content: id, status: 'success' }
}

describe('route rebase entity + block cleanup', () => {
  it('removes old-exclusive message entities, reuses stable IDs, and drops exclusive blocks', () => {
    let state: any = undefined
    state = appReducer(state, { type: '@@INIT' })
    // Old route: m0(shared) + mOld(exclusive) with blocks.
    state = appReducer(
      state,
      newMessagesActions.messagesReceived({ topicId: 't1', messages: [msg('m0', ['b-m0']), msg('mOld', ['b-old'])] })
    )
    state = appReducer(
      state,
      messageBlocksSlice.actions.upsertManyBlocks([block('b-m0', 'm0'), block('b-old', 'mOld')])
    )
    expect(state.messages.entities['mOld']).toBeTruthy()
    expect(state.messageBlocks.entities['b-old']).toBeTruthy()
    // New route: m0(shared, reused) + mNew. Root reducer handles cross-slice block cleanup atomically.
    state = appReducer(
      state,
      newMessagesActions.rebaseRouteMessages({ topicId: 't1', messages: [msg('m0', ['b-m0']), msg('mNew', ['b-new'])] })
    )
    state = appReducer(state, messageBlocksSlice.actions.upsertManyBlocks([block('b-new', 'mNew')]))
    // Old exclusive message gone via direct selector; shared reused.
    expect(state.messages.entities['mOld']).toBeUndefined()
    expect(state.messages.entities['m0']).toBeTruthy()
    expect(state.messages.entities['mNew']).toBeTruthy()
    expect(state.messages.messageIdsByTopic['t1']).toEqual(['m0', 'mNew'])
    // Exclusive block of the old route removed (rootReducer), shared kept.
    expect(state.messageBlocks.entities['b-old']).toBeUndefined()
    expect(state.messageBlocks.entities['b-m0']).toBeTruthy()
  })

  it('does not remove an ID still listed by another topic', () => {
    let state: any = undefined
    state = appReducer(state, { type: '@@INIT' })
    state = appReducer(state, newMessagesActions.messagesReceived({ topicId: 't1', messages: [msg('shared', [])] }))
    state = appReducer(
      state,
      newMessagesActions.messagesReceived({ topicId: 't2', messages: [{ ...msg('shared', []), topicId: 't2' }] })
    )
    state = appReducer(
      state,
      newMessagesActions.rebaseRouteMessages({ topicId: 't1', messages: [msg('only-new', [])] })
    )
    // shared still listed by t2 → entity kept.
    expect(state.messages.entities['shared']).toBeTruthy()
  })
})
