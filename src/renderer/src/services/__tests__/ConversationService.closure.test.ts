import type { Assistant } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import {
  AssistantMessageStatus,
  MessageBlockStatus,
  MessageBlockType,
  UserMessageStatus
} from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { fetchClosureMock, fetchWholeTopicSnapshotMock, getSettingsMock, getDefaultModelMock, blockEntities } =
  vi.hoisted(() => ({
    fetchClosureMock: vi.fn(),
    fetchWholeTopicSnapshotMock: vi.fn(),
    getSettingsMock: vi.fn(),
    getDefaultModelMock: vi.fn(() => ({ id: 'm', provider: 'p', name: 'm', group: 'g' }) as any),
    blockEntities: {} as Record<string, any>
  }))

vi.mock('@renderer/i18n', () => ({ default: { t: (k: string) => k } }))
vi.mock('@renderer/store', () => ({
  default: {
    getState: () => ({
      settings: { injectContextTimestamp: false },
      messageBlocks: { entities: blockEntities },
      messages: { entities: {}, messageIdsByTopic: {} }
    }),
    dispatch: vi.fn()
  }
}))
vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultModel: getDefaultModelMock,
  getAssistantSettings: (...args: any[]) => getSettingsMock(...args)
}))
vi.mock('@renderer/services/db', () => ({
  dbService: {
    fetchContextClosure: (...args: any[]) => fetchClosureMock(...args),
    fetchWholeTopicSnapshot: (...args: any[]) => fetchWholeTopicSnapshotMock(...args)
  }
}))
import { buildBlockOverlay } from '@renderer/services/requestBlockOverlay'

import { ConversationService } from '../ConversationService'

const TS = '2026-01-01T00:00:00.000Z'

function userMsg(id: string, text: string): { message: Message; block: MessageBlock } {
  const blockId = `${id}-block`
  return {
    message: {
      id,
      role: 'user',
      assistantId: 'asst-1',
      topicId: 't1',
      createdAt: TS,
      updatedAt: TS,
      status: UserMessageStatus.SUCCESS,
      blocks: [blockId]
    } as unknown as Message,
    block: {
      id: blockId,
      messageId: id,
      type: MessageBlockType.MAIN_TEXT,
      content: text,
      createdAt: TS,
      updatedAt: TS,
      status: MessageBlockStatus.SUCCESS
    } as unknown as MessageBlock
  }
}

function assistantMsg(id: string, askId: string, text: string): { message: Message; block: MessageBlock } {
  const blockId = `${id}-block`
  return {
    message: {
      id,
      role: 'assistant',
      askId,
      assistantId: 'asst-1',
      topicId: 't1',
      createdAt: TS,
      updatedAt: TS,
      status: AssistantMessageStatus.SUCCESS,
      blocks: [blockId]
    } as unknown as Message,
    block: {
      id: blockId,
      messageId: id,
      type: MessageBlockType.MAIN_TEXT,
      content: text,
      createdAt: TS,
      updatedAt: TS,
      status: MessageBlockStatus.SUCCESS
    } as unknown as MessageBlock
  }
}

function makeClosureResponse(
  entries: Array<{ message: Message; block: MessageBlock }>,
  opts: { topicId: string; anchorGroupKey: string; totalTurnCount: number; selectedTurnCount: number }
) {
  const messages = entries.map((e) => ({ ...e.message }))
  const blocks = entries.map((e) => ({ ...e.block }))
  const first = messages[0]?.id ?? null
  const last = messages[messages.length - 1]?.id ?? null
  const boundary = opts.selectedTurnCount === opts.totalTurnCount ? null : first
  return {
    messages: messages as any,
    blocks: blocks as any,
    closure: {
      completeness: 'context-closure',
      topicId: opts.topicId,
      anchorGroupKey: opts.anchorGroupKey,
      firstMessageId: first,
      lastMessageId: last,
      returnedCount: messages.length,
      totalTurnCount: opts.totalTurnCount,
      selectedTurnCount: opts.selectedTurnCount,
      boundaryMessageId: boundary
    }
  }
}

function makeRouteSnapshot(entries: Array<{ message: Message; block: MessageBlock }>, topicId: string) {
  const messages = entries.map((e) => ({ ...e.message }))
  const blocks = entries.map((e) => ({ ...e.block }))
  return {
    messages: messages as any,
    blocks: blocks as any,
    snapshot: {
      completeness: 'whole-topic',
      topicId,
      firstMessageId: messages[0]?.id ?? null,
      lastMessageId: messages[messages.length - 1]?.id ?? null,
      returnedCount: messages.length
    }
  }
}

function assistantWithAnchor(routeKey: string, groupKey: string): Assistant {
  return {
    id: 'asst-1',
    settings: { contextCount: 5, contextWindowAnchor: { [routeKey]: { kind: 'active', groupKey } } },
    model: { id: 'm', provider: 'p', name: 'm', group: 'g' }
  } as unknown as Assistant
}

function sdkTexts(modelMessages: any[], role: string): string[] {
  return modelMessages
    .filter((m) => m?.role === role)
    .map((m) => {
      const c = m?.content
      if (typeof c === 'string') return c
      if (Array.isArray(c)) {
        return c.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
      }
      return ''
    })
}

describe('ConversationService actual outbound window (authority closure)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const k of Object.keys(blockEntities)) delete blockEntities[k]
    getDefaultModelMock.mockReturnValue({ id: 'm', provider: 'p', name: 'm', group: 'g' } as any)
  })

  it('branch offviewport anchor: full closure IDs/blocks, ordered historical users + trigger, excludes before-anchor/main-only/future', async () => {
    // Authority route b1: anchor u2 through newest (u2..u5-future + stub).
    // Before-anchor u0/u1 and main-only rows are absent from the closure by
    // construction; future u5 must be clipped by the trigger boundary.
    const u2 = userMsg('u2', 'hist-u2')
    const a2 = assistantMsg('a2', 'u2', 'hist-a2')
    const u3 = userMsg('u3', 'hist-u3')
    const a3 = assistantMsg('a3', 'u3', 'hist-a3')
    const u4 = userMsg('u4', 'trigger-u4')
    const u5future = userMsg('u5-future', 'future-u5')
    const closure = makeClosureResponse([u2, a2, u3, a3, u4, u5future], {
      topicId: 't1',
      anchorGroupKey: 'u2',
      totalTurnCount: 5,
      selectedTurnCount: 3
    })
    // Closure first must be the anchor for a partial window.
    closure.closure.firstMessageId = 'u2'
    closure.closure.boundaryMessageId = 'u2'
    fetchClosureMock.mockResolvedValue(closure)
    getSettingsMock.mockReturnValue({
      contextCount: 5,
      contextWindowAnchor: { 't1:b1': { kind: 'active', groupKey: 'u2' } }
    })
    const assistant = assistantWithAnchor('t1:b1', 'u2')

    // Loaded viewport is the truncated latest tail whose oldest (u3) is
    // strictly newer than the persisted anchor (u2): cache warmup absent.
    // The caller slice is already clipped to the initiating trigger (u4);
    // the later queued future (u5) lives only in the fresh authority closure.
    const viewport: Message[] = [{ ...u3.message }, { ...a3.message }, { ...u4.message }]
    const result = await ConversationService.prepareMessagesForModel(viewport, assistant, 't1', undefined, 'b1')

    expect(fetchClosureMock).toHaveBeenCalledTimes(1)
    expect(fetchClosureMock).toHaveBeenCalledWith({ topicId: 't1', branchId: 'b1', anchorGroupKey: 'u2' })
    expect(fetchWholeTopicSnapshotMock).not.toHaveBeenCalled()
    const userTexts = sdkTexts(result.modelMessages, 'user')
    const assistantTexts = sdkTexts(result.modelMessages, 'assistant')
    // Exact ordered historical users + trigger; future clipped, stub removed.
    expect(userTexts).toEqual(['hist-u2', 'hist-u3', 'trigger-u4'])
    expect(assistantTexts).toEqual(['hist-a2', 'hist-a3'])
    expect(userTexts).not.toContain('future-u5')
    for (const excluded of ['hist-u0', 'hist-u1', 'main-only']) {
      expect(userTexts).not.toContain(excluded)
    }
    // uiMessages carry the same authoritative IDs in order (trigger last).
    expect(result.uiMessages.map((m) => m.id)).toEqual(['u2', 'a2', 'u3', 'a3', 'u4'])
  })

  it('authorityUser with zero loaded prefix still sends full prefix + overlay fresh trigger text', async () => {
    const u2 = userMsg('u2', 'hist-u2')
    const a2 = assistantMsg('a2', 'u2', 'hist-a2')
    const u3 = userMsg('u3', 'hist-u3')
    const a3 = assistantMsg('a3', 'u3', 'hist-a3')
    const u4old = userMsg('u4', 'stale-u4')
    const closure = makeClosureResponse([u2, a2, u3, a3, u4old], {
      topicId: 't1',
      anchorGroupKey: 'u2',
      totalTurnCount: 5,
      selectedTurnCount: 3
    })
    closure.closure.firstMessageId = 'u2'
    closure.closure.boundaryMessageId = 'u2'
    fetchClosureMock.mockResolvedValue(closure)
    getSettingsMock.mockReturnValue({
      contextCount: 5,
      contextWindowAnchor: { 't1:b1': { kind: 'active', groupKey: 'u2' } }
    })
    const assistant = assistantWithAnchor('t1:b1', 'u2')

    // Fresh edited trigger (same stable ID, new block content).
    const fresh = userMsg('u4', 'edited-trigger-u4')
    const authorityUser = { message: fresh.message, blocks: buildBlockOverlay([fresh.block]) }

    const result = await ConversationService.prepareMessagesForModel([], assistant, 't1', authorityUser, 'b1')
    expect(fetchClosureMock).toHaveBeenCalledWith({ topicId: 't1', branchId: 'b1', anchorGroupKey: 'u2' })
    const userTexts = sdkTexts(result.modelMessages, 'user')
    expect(fetchWholeTopicSnapshotMock).not.toHaveBeenCalled()
    const assistantTexts = sdkTexts(result.modelMessages, 'assistant')
    expect(userTexts).toEqual(['hist-u2', 'hist-u3', 'edited-trigger-u4'])
    expect(userTexts).not.toContain('stale-u4')
    expect(assistantTexts).toEqual(['hist-a2', 'hist-a3'])
  })

  it('authority read rejection never computes/sends a loaded partial (fail-closed)', async () => {
    fetchClosureMock.mockRejectedValue(new Error('IPC fail'))
    getSettingsMock.mockReturnValue({
      contextCount: 5,
      contextWindowAnchor: { t1: { kind: 'active', groupKey: 'u2' } }
    })
    const assistant = assistantWithAnchor('t1', 'u2')
    const u4 = userMsg('u4', 'trigger-u4')
    await expect(
      ConversationService.prepareMessagesForModel([u4.message] as Message[], assistant, 't1', undefined, null)
    ).rejects.toThrow('IPC fail')
    expect(fetchClosureMock).toHaveBeenCalledTimes(1)
  })

  it('missing trigger in authority closure fails closed instead of viewport partial', async () => {
    const u2 = userMsg('u2', 'hist-u2')
    const a2 = assistantMsg('a2', 'u2', 'hist-a2')
    const closure = makeClosureResponse([u2, a2], {
      topicId: 't1',
      anchorGroupKey: 'u2',
      totalTurnCount: 3,
      selectedTurnCount: 1
    })
    closure.closure.firstMessageId = 'u2'
    closure.closure.boundaryMessageId = 'u2'
    fetchClosureMock.mockResolvedValue(closure)
    getSettingsMock.mockReturnValue({
      contextCount: 5,
      contextWindowAnchor: { t1: { kind: 'active', groupKey: 'u2' } }
    })
    const assistant = assistantWithAnchor('t1', 'u2')
    // The ghost trigger is absent from both the anchored closure and the
    // authoritative route: no viewport partial, no widening.
    fetchWholeTopicSnapshotMock.mockResolvedValue(makeRouteSnapshot([u2, a2], 't1'))
    const ghost = userMsg('ghost', 'ghost')
    await expect(
      ConversationService.prepareMessagesForModel([ghost.message] as Message[], assistant, 't1', undefined, null)
    ).rejects.toThrow('not in authority route')
  })

  it('pre-anchor insert: full authoritative route prefix through the trigger, no post-trigger reply, no contextCount clip', async () => {
    // Persisted anchor is u3; the trigger u2 precedes it (insert above the
    // boundary). The anchored closure starts at u3 and structurally cannot
    // carry u0..u2, so the authority route read supplies the prefix.
    const u0 = userMsg('u0', 'hist-u0')
    const a0 = assistantMsg('a0', 'u0', 'hist-a0')
    const u1 = userMsg('u1', 'hist-u1')
    const a1 = assistantMsg('a1', 'u1', 'hist-a1')
    const u2 = userMsg('u2', 'trigger-u2')
    const a2old = assistantMsg('a2-old', 'u2', 'old-reply-a2')
    const u3 = userMsg('u3', 'hist-u3')
    const a3 = assistantMsg('a3', 'u3', 'hist-a3')
    const closure = makeClosureResponse([u3, a3], {
      topicId: 't1',
      anchorGroupKey: 'u3',
      totalTurnCount: 4,
      selectedTurnCount: 2
    })
    closure.closure.firstMessageId = 'u3'
    closure.closure.boundaryMessageId = 'u3'
    fetchClosureMock.mockResolvedValue(closure)
    fetchWholeTopicSnapshotMock.mockResolvedValue(makeRouteSnapshot([u0, a0, u1, a1, u2, a2old, u3, a3], 't1'))
    // Narrow persisted window: the prefix must NOT be clipped by contextCount.
    const settings = { contextCount: 1, contextWindowAnchor: { 't1:b1': { kind: 'active', groupKey: 'u3' } } }
    getSettingsMock.mockReturnValue(settings)
    const settingsBefore = JSON.parse(JSON.stringify(settings))
    const assistant = assistantWithAnchor('t1:b1', 'u3')
    const authorityUser = { message: u2.message, blocks: buildBlockOverlay([u2.block]) }

    const result = await ConversationService.prepareMessagesForModel([], assistant, 't1', authorityUser, 'b1')

    // The prefix is read on the pinned effective route, not the current active.
    expect(fetchWholeTopicSnapshotMock).toHaveBeenCalledWith('t1', 'b1')
    expect(sdkTexts(result.modelMessages, 'user')).toEqual(['hist-u0', 'hist-u1', 'trigger-u2'])
    expect(sdkTexts(result.modelMessages, 'assistant')).toEqual(['hist-a0', 'hist-a1'])
    // Exact ordered authority IDs, trigger last; the trigger's existing reply
    // and everything below the trigger are excluded.
    expect(result.uiMessages.map((m) => m.id)).toEqual(['u0', 'a0', 'u1', 'a1', 'u2'])
    expect(result.uiMessages.map((m) => m.id)).not.toContain('a2-old')
    expect(sdkTexts(result.modelMessages, 'assistant')).not.toContain('old-reply-a2')
    for (const excluded of ['hist-u3', 'hist-a3']) {
      expect(sdkTexts(result.modelMessages, 'user')).not.toContain(excluded)
    }
    // Read-only: the persisted anchor (and the rest of the settings) is unchanged.
    expect(settings).toEqual(settingsBefore)
  })

  it('pre-anchor history is authoritative, never the loaded viewport slice', async () => {
    const u0 = userMsg('u0', 'hist-u0')
    const a0 = assistantMsg('a0', 'u0', 'hist-a0')
    const u1 = userMsg('u1', 'trigger-u1')
    const u2 = userMsg('u2', 'hist-u2')
    const a2 = assistantMsg('a2', 'u2', 'hist-a2')
    const closure = makeClosureResponse([u2, a2], {
      topicId: 't1',
      anchorGroupKey: 'u2',
      totalTurnCount: 3,
      selectedTurnCount: 2
    })
    closure.closure.firstMessageId = 'u2'
    closure.closure.boundaryMessageId = 'u2'
    fetchClosureMock.mockResolvedValue(closure)
    fetchWholeTopicSnapshotMock.mockResolvedValue(makeRouteSnapshot([u0, a0, u1, u2, a2], 't1'))
    getSettingsMock.mockReturnValue({
      contextCount: 5,
      contextWindowAnchor: { 't1:b1': { kind: 'active', groupKey: 'u2' } }
    })
    const assistant = assistantWithAnchor('t1:b1', 'u2')

    // Loaded viewport is an incomplete tail: it carries only the trigger u1,
    // missing the authoritative above-trigger history u0/a0.
    const viewport: Message[] = [{ ...u1.message }]
    const result = await ConversationService.prepareMessagesForModel(viewport, assistant, 't1', undefined, 'b1')

    expect(sdkTexts(result.modelMessages, 'user')).toEqual(['hist-u0', 'trigger-u1'])
    expect(sdkTexts(result.modelMessages, 'assistant')).toEqual(['hist-a0'])
  })

  it('pre-anchor trigger missing from the addressed route fails closed', async () => {
    const u2 = userMsg('u2', 'hist-u2')
    const a2 = assistantMsg('a2', 'u2', 'hist-a2')
    const closure = makeClosureResponse([u2, a2], {
      topicId: 't1',
      anchorGroupKey: 'u2',
      totalTurnCount: 3,
      selectedTurnCount: 2
    })
    closure.closure.firstMessageId = 'u2'
    closure.closure.boundaryMessageId = 'u2'
    fetchClosureMock.mockResolvedValue(closure)
    // Route read for b1 has no sibling-branch / other-route trigger: no widening.
    fetchWholeTopicSnapshotMock.mockResolvedValue(makeRouteSnapshot([u2, a2], 't1'))
    getSettingsMock.mockReturnValue({
      contextCount: 5,
      contextWindowAnchor: { 't1:b1': { kind: 'active', groupKey: 'u2' } }
    })
    const assistant = assistantWithAnchor('t1:b1', 'u2')
    const foreign = userMsg('main-only', 'main-only-u9')
    const authorityUser = { message: foreign.message, blocks: buildBlockOverlay([foreign.block]) }

    await expect(ConversationService.prepareMessagesForModel([], assistant, 't1', authorityUser, 'b1')).rejects.toThrow(
      'not in authority route'
    )
  })

  it('pre-anchor route read failure and invalid completeness never fall back to the viewport', async () => {
    const u2 = userMsg('u2', 'hist-u2')
    const a2 = assistantMsg('a2', 'u2', 'hist-a2')
    const closure = makeClosureResponse([u2, a2], {
      topicId: 't1',
      anchorGroupKey: 'u2',
      totalTurnCount: 3,
      selectedTurnCount: 2
    })
    closure.closure.firstMessageId = 'u2'
    closure.closure.boundaryMessageId = 'u2'
    fetchClosureMock.mockResolvedValue(closure)
    getSettingsMock.mockReturnValue({
      contextCount: 5,
      contextWindowAnchor: { t1: { kind: 'active', groupKey: 'u2' } }
    })
    const assistant = assistantWithAnchor('t1', 'u2')
    const trigger = userMsg('u0', 'trigger-u0')
    const authorityUser = { message: trigger.message, blocks: buildBlockOverlay([trigger.block]) }
    const viewport: Message[] = [{ ...trigger.message }]

    fetchWholeTopicSnapshotMock.mockRejectedValue(new Error('IPC fail'))
    await expect(
      ConversationService.prepareMessagesForModel(viewport, assistant, 't1', authorityUser, null)
    ).rejects.toThrow('IPC fail')

    const mislabeled = makeRouteSnapshot([trigger], 't1')
    mislabeled.snapshot.completeness = 'context-closure' as any
    fetchWholeTopicSnapshotMock.mockResolvedValue(mislabeled)
    await expect(
      ConversationService.prepareMessagesForModel(viewport, assistant, 't1', authorityUser, null)
    ).rejects.toThrow('invalid route history')
  })

  it('no-topic local helper retains bounded behavior without authority read', async () => {
    const u1 = userMsg('u1', 'hello')
    blockEntities[u1.block.id] = { ...u1.block }
    getSettingsMock.mockReturnValue({ contextCount: 5, contextWindowAnchor: {} })
    const assistant = {
      id: 'asst-1',
      settings: { contextCount: 5, contextWindowAnchor: {} },
      model: { id: 'm', provider: 'p', name: 'm', group: 'g' }
    } as unknown as Assistant
    const result = await ConversationService.prepareMessagesForModel([u1.message] as Message[], assistant)
    expect(fetchClosureMock).not.toHaveBeenCalled()
    expect(sdkTexts(result.modelMessages, 'user')).toEqual(['hello'])
  })

  it('topic without persisted anchor fails closed without silent default', async () => {
    getSettingsMock.mockReturnValue({ contextCount: 5, contextWindowAnchor: {} })
    const assistant = {
      id: 'asst-1',
      settings: { contextCount: 5, contextWindowAnchor: {} },
      model: { id: 'm', provider: 'p', name: 'm', group: 'g' }
    } as unknown as Assistant
    const u1 = userMsg('u1', 'hello')
    await expect(
      ConversationService.prepareMessagesForModel([u1.message] as Message[], assistant, 't1', undefined, null)
    ).rejects.toThrow('missing persisted context anchor')
    expect(fetchClosureMock).not.toHaveBeenCalled()
  })

  it('request conversion applies only the shared pipeline to the anchor-clipped slice (unknown-role rows stay out)', async () => {
    // Authority route: anchor u2 .. trigger u4, with a queued future user and
    // the trigger's assistant stub after it, plus a non-turn row inside the
    // window (unknown role — in authority order but in no context turn).
    const u2 = userMsg('u2', 'hist-u2')
    const a2 = assistantMsg('a2', 'u2', 'hist-a2')
    const strayRow = userMsg('stray', 'stray-unknown-role')
    const stray = { ...strayRow.message, role: 'tool' } as unknown as Message
    const u3 = userMsg('u3', 'hist-u3')
    const a3 = assistantMsg('a3', 'u3', 'hist-a3')
    const u4 = userMsg('u4', 'trigger-u4')
    const a4stub = assistantMsg('a4-stub', 'u4', 'stub-a4')
    const u5future = userMsg('u5-future', 'future-u5')
    const closure = makeClosureResponse(
      [u2, a2, { message: stray, block: strayRow.block }, u3, a3, u4, a4stub, u5future],
      {
        topicId: 't1',
        anchorGroupKey: 'u2',
        totalTurnCount: 4,
        selectedTurnCount: 4
      }
    )
    fetchClosureMock.mockResolvedValue(closure)
    getSettingsMock.mockReturnValue({
      contextCount: 5,
      contextWindowAnchor: { 't1:b1': { kind: 'active', groupKey: 'u2' } }
    })
    const assistant = assistantWithAnchor('t1:b1', 'u2')

    const result = await ConversationService.prepareMessagesForModel(
      [u4.message] as Message[],
      assistant,
      't1',
      undefined,
      'b1'
    )

    // Anchor inclusive through the trigger only; non-turn rows and everything
    // after the trigger are excluded.
    expect(result.uiMessages.map((m) => m.id)).toEqual(['u2', 'a2', 'u3', 'a3', 'u4'])
    expect(sdkTexts(result.modelMessages, 'user')).toEqual(['hist-u2', 'hist-u3', 'trigger-u4'])
    expect(sdkTexts(result.modelMessages, 'assistant')).toEqual(['hist-a2', 'hist-a3'])
  })

  it('the request window comes from the validated closure alone (contextCount never re-derives it)', async () => {
    // Three anchor-to-trigger turns; a small contextCount must not shrink the
    // already-authoritative slice (the window is the persisted anchor to the
    // trigger, never a "last N turns" re-derivation over this bounded slice).
    const u2 = userMsg('u2', 'hist-u2')
    const a2 = assistantMsg('a2', 'u2', 'hist-a2')
    const u3 = userMsg('u3', 'hist-u3')
    const a3 = assistantMsg('a3', 'u3', 'hist-a3')
    const u4 = userMsg('u4', 'trigger-u4')
    const closure = makeClosureResponse([u2, a2, u3, a3, u4], {
      topicId: 't1',
      anchorGroupKey: 'u2',
      totalTurnCount: 3,
      selectedTurnCount: 3
    })
    fetchClosureMock.mockResolvedValue(closure)
    getSettingsMock.mockReturnValue({
      contextCount: 1,
      contextWindowAnchor: { t1: { kind: 'active', groupKey: 'u2' } }
    })
    const assistant = assistantWithAnchor('t1', 'u2')

    const result = await ConversationService.prepareMessagesForModel(
      [u4.message] as Message[],
      assistant,
      't1',
      undefined,
      null
    )

    expect(result.uiMessages.map((m) => m.id)).toEqual(['u2', 'a2', 'u3', 'a3', 'u4'])
  })
})
