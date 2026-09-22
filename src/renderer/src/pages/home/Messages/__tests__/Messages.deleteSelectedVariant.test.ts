/**
 * Semantic delete viewport — selected variant blank interval.
 *
 * Proves the deterministic transition that creates the blank candidate:
 * a passive reconciliation leaves one commit where the stale group still
 * selects the deleted variant (now blockless) and fold CSS hides the
 * survivor. Layout-phase reconciliation (co-located previous snapshot
 * update) removes that candidate by reconciling before paint.
 *
 * Keeps invariants: window not reset, generation unchanged, range not null,
 * survivor group shrinks to single message with thinking→main_text order.
 * No paint claim — actual paint continuity is proven by E2E sampling.
 */
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import { createMessageViewportState, messageViewportReducer } from '../messageViewportReducer'
import { createLatestMessageWindow, reconcileMessageWindow } from '../messageWindow'

function makeUser(id: string): Message {
  return {
    id,
    topicId: 't-sel-del',
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'success',
    blocks: [`${id}-block`],
    askId: undefined
  } as unknown as Message
}

function makeBlock(id: string, messageId: string, type: MessageBlockType, content: string): MessageBlock {
  return {
    id,
    messageId,
    type,
    content,
    status: MessageBlockStatus.SUCCESS,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  } as unknown as MessageBlock
}

function makeAssistant(id: string, askId: string, foldSelected: boolean, blocks: string[]): Message {
  return {
    id,
    topicId: 't-sel-del',
    role: 'assistant',
    askId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'success',
    blocks,
    foldSelected,
    useful: undefined
  } as unknown as Message
}

function selectedMessageId(messages: readonly Message[]): string | undefined {
  if (messages.length === 1) return messages[0]?.id
  const selected = messages.find((m) => (m as Message & { foldSelected?: boolean }).foldSelected)
  if (selected) return selected.id
  return messages[0]?.id
}

describe('selected variant delete — stale vs reconciled group', () => {
  it('stale group selects deleted variant and hides survivor; reconciled selects survivor', () => {
    const u1 = makeUser('u1')
    const bThinkA1 = makeBlock('b-think-a1', 'a1', MessageBlockType.THINKING, 'thinking-short')
    const bMainA1 = makeBlock('b-main-a1', 'a1', MessageBlockType.MAIN_TEXT, 'main-short')
    const bThinkA2 = makeBlock('b-think-a2', 'a2', MessageBlockType.THINKING, 'thinking-long-survivor')
    const bMainA2 = makeBlock('b-main-a2', 'a2', MessageBlockType.MAIN_TEXT, 'main-long-survivor')

    const a1 = makeAssistant('a1', 'ask-1', true, [bThinkA1.id, bMainA1.id])
    const a2 = makeAssistant('a2', 'ask-1', false, [bThinkA2.id, bMainA2.id])

    const initialMessages: Message[] = [u1, a1, a2]
    const afterMessages: Message[] = [u1, a2]

    const initialWindow = createLatestMessageWindow(initialMessages, 10, {
      hasMoreBefore: false,
      hasMoreAfter: false
    })

    // Initial grouping: [u1] + [a1,a2] sharing askId
    expect(initialWindow.displayGroups).toHaveLength(2)
    const groupBefore = initialWindow.displayGroups.find((g) => g.messages.some((m) => m.id === 'a1'))!
    expect(groupBefore.messages.map((m) => m.id)).toEqual(['a1', 'a2'])
    expect(selectedMessageId(groupBefore.messages)).toBe('a1')
    // Fold: only selected is visible
    expect(
      groupBefore.messages.filter((m) => m.id === selectedMessageId(groupBefore.messages)).map((m) => m.id)
    ).toEqual(['a1'])

    // Stale window (no reconciliation yet) still selects deleted a1 → survivor hidden
    const staleGroup = groupBefore
    const staleSelected = selectedMessageId(staleGroup.messages)
    expect(staleSelected).toBe('a1')
    expect(staleGroup.messages.map((m) => m.id)).toEqual(['a1', 'a2'])
    // Survivor hidden in fold mode
    expect(staleGroup.messages.filter((m) => m.id === staleSelected).map((m) => m.id)).not.toContain('a2')

    // Reconciled window must drop deleted variant
    const reconciled = reconcileMessageWindow(afterMessages, initialMessages, initialWindow)
    expect(reconciled.displayMessages.map((m) => m.id)).toEqual(['a2', 'u1'])
    expect(reconciled.displayGroups).toHaveLength(2)
    const groupAfter = reconciled.displayGroups.find((g) => g.messages.some((m) => m.id === 'a2'))!
    expect(groupAfter.messages.map((m) => m.id)).toEqual(['a2'])
    expect(selectedMessageId(groupAfter.messages)).toBe('a2')
    expect(groupAfter.messages.filter((m) => m.id === selectedMessageId(groupAfter.messages)).map((m) => m.id)).toEqual(
      ['a2']
    )

    // No reset/reload: generation unchanged, window not nulled, range intact
    const initialState = createMessageViewportState(initialWindow)
    const nextState = messageViewportReducer(initialState, { type: 'window/apply', window: reconciled })
    expect(nextState.topicGeneration).toBe(initialState.topicGeneration)
    expect(nextState.window).not.toBeNull()
    expect(nextState.window?.range).not.toBeNull()
    expect(nextState.window?.displayMessages).toHaveLength(2)

    // Thinking→main_text order preserved for survivor (no conditional skip)
    expect(groupAfter.messages[0].blocks).toEqual([bThinkA2.id, bMainA2.id])
    expect([bThinkA2.type, bMainA2.type]).toEqual([MessageBlockType.THINKING, MessageBlockType.MAIN_TEXT])
  })

  it('reconciled window removes blank candidate deterministically across repeated deletes', () => {
    const u1 = makeUser('u1')
    const bThinkA1 = makeBlock('b-think-a1', 'a1', MessageBlockType.THINKING, 't1')
    const bMainA1 = makeBlock('b-main-a1', 'a1', MessageBlockType.MAIN_TEXT, 'm1')
    const bThinkA2 = makeBlock('b-think-a2', 'a2', MessageBlockType.THINKING, 't2')
    const bMainA2 = makeBlock('b-main-a2', 'a2', MessageBlockType.MAIN_TEXT, 'm2')
    const bThinkA3 = makeBlock('b-think-a3', 'a3', MessageBlockType.THINKING, 't3')
    const bMainA3 = makeBlock('b-main-a3', 'a3', MessageBlockType.MAIN_TEXT, 'm3')

    const a1 = makeAssistant('a1', 'ask-1', true, [bThinkA1.id, bMainA1.id])
    const a2 = makeAssistant('a2', 'ask-1', false, [bThinkA2.id, bMainA2.id])
    const a3 = makeAssistant('a3', 'ask-1', false, [bThinkA3.id, bMainA3.id])

    const initialMessages = [u1, a1, a2, a3]
    const initialWindow = createLatestMessageWindow(initialMessages, 10)

    const groupInitial = initialWindow.displayGroups.find((g) => g.messages.some((m) => m.id === 'a1'))!
    expect(groupInitial.messages.map((m) => m.id)).toEqual(['a1', 'a2', 'a3'])
    expect(selectedMessageId(groupInitial.messages)).toBe('a1')

    // Delete selected a1 → survivor a2 becomes selected
    const afterFirst = [u1, a2, a3]
    const win1 = reconcileMessageWindow(afterFirst, initialMessages, initialWindow)
    const g1 = win1.displayGroups.find((g) => g.messages.some((m) => m.id === 'a2'))!
    expect(g1.messages.map((m) => m.id)).toEqual(['a2', 'a3'])
    expect(selectedMessageId(g1.messages)).toBe('a2')

    // Delete new selected a2 → survivor a3
    const afterSecond = [u1, a3]
    const win2 = reconcileMessageWindow(afterSecond, afterFirst, win1)
    const g2 = win2.displayGroups.find((g) => g.messages.some((m) => m.id === 'a3'))!
    expect(g2.messages.map((m) => m.id)).toEqual(['a3'])
    expect(selectedMessageId(g2.messages)).toBe('a3')
    expect(g2.messages[0].blocks).toEqual([bThinkA3.id, bMainA3.id])
  })
})
