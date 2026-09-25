import { describe, expect, it } from 'vitest'

import { chatDbContracts, validateChatDbRequest, validateChatDbResult } from '../contracts'

const MODEL = { id: 'm-1', provider: 'openai', name: 'gpt', group: 'g' }

function validResendRequest() {
  return { topicId: 't-1', userMessageId: 'u-1', assistantId: 'a-1', currentModel: { ...MODEL } }
}

function validRegenRequest() {
  return { topicId: 't-1', assistantMessageId: 'a-1', assistantId: 'as-1', currentModel: { ...MODEL } }
}

function validSemanticValue() {
  return {
    affectedFileIds: [],
    remainingReferenceCounts: {},
    topicId: 't-1',
    askId: 'u-1',
    userMessage: { id: 'u-1', topicId: 't-1', role: 'user', blocks: ['b-u'] },
    userBlocks: [{ id: 'b-u', messageId: 'u-1', type: 'main_text', content: 'hi' }],
    executionMessages: [{ message: { id: 'a-1', topicId: 't-1', role: 'assistant', blocks: [] }, blocks: [] }],
    removedBlockIds: ['b-old'],
    createdMessageIds: [],
    attempts: [{ messageId: 'a-1', attemptId: 'att-1' }]
  }
}

describe('semantic resend/regenerate contracts', () => {
  it('registers both channels with strict keys', () => {
    expect(chatDbContracts['chatdb:resend-user-messages']).toBeDefined()
    expect(chatDbContracts['chatdb:regenerate-assistant-message']).toBeDefined()
    expect([...chatDbContracts['chatdb:resend-user-messages'].allowedKeys].sort()).toEqual(
      ['assistantId', 'branchId', 'currentModel', 'topicId', 'userMessageId'].sort()
    )
    expect([...chatDbContracts['chatdb:regenerate-assistant-message'].allowedKeys].sort()).toEqual(
      ['assistantId', 'assistantMessageId', 'branchId', 'currentModel', 'topicId'].sort()
    )
  })

  it('accepts minimal valid requests', () => {
    expect(() => validateChatDbRequest('chatdb:resend-user-messages', validResendRequest())).not.toThrow()
    expect(() => validateChatDbRequest('chatdb:regenerate-assistant-message', validRegenRequest())).not.toThrow()
  })

  it('rejects unknown keys, missing ids, and model without id', () => {
    expect(() =>
      validateChatDbRequest('chatdb:resend-user-messages', { ...validResendRequest(), mentions: [] })
    ).toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:resend-user-messages', { ...validResendRequest(), userMessageId: '' })
    ).toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:resend-user-messages', {
        ...validResendRequest(),
        currentModel: { provider: 'x' }
      })
    ).toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:regenerate-assistant-message', {
        ...validRegenRequest(),
        currentModel: { id: '' }
      })
    ).toThrow()
  })

  it('accepts valid semantic responses', () => {
    expect(() =>
      validateChatDbResult('chatdb:resend-user-messages', { ok: true, value: validSemanticValue() })
    ).not.toThrow()
    expect(() =>
      validateChatDbResult('chatdb:regenerate-assistant-message', { ok: true, value: validSemanticValue() })
    ).not.toThrow()
  })

  it('rejects unknown value keys and non-1:1 attempts', () => {
    const withExtra = { ...validSemanticValue(), extra: 1 }
    expect(() => validateChatDbResult('chatdb:resend-user-messages', { ok: true, value: withExtra })).toThrow()
    const mismatch = {
      ...validSemanticValue(),
      executionMessages: [
        { message: { id: 'a-1', topicId: 't-1', blocks: [] }, blocks: [] },
        { message: { id: 'a-2', topicId: 't-1', blocks: [] }, blocks: [] }
      ],
      attempts: [{ messageId: 'a-1', attemptId: 'x' }]
    }
    expect(() => validateChatDbResult('chatdb:resend-user-messages', { ok: true, value: mismatch })).toThrow()
    const badCreated = { ...validSemanticValue(), createdMessageIds: ['missing-id'] }
    expect(() => validateChatDbResult('chatdb:resend-user-messages', { ok: true, value: badCreated })).toThrow()
    const emptyExec = { ...validSemanticValue(), executionMessages: [], attempts: [] }
    expect(() => validateChatDbResult('chatdb:resend-user-messages', { ok: true, value: emptyExec })).toThrow()
  })

  it('rejects undefined own props via JSON safety', () => {
    const v = validSemanticValue() as Record<string, unknown>
    v.askId = undefined as unknown as string
    expect(() => validateChatDbResult('chatdb:resend-user-messages', { ok: true, value: v })).toThrow()
  })

  it('regenerate currentModel optional: absence legal, resend still required', () => {
    // Self-modelId path: no currentModel must validate clean.
    const noModel = { topicId: 't-1', assistantMessageId: 'a-1', assistantId: 'as-1' }
    expect(() => validateChatDbRequest('chatdb:regenerate-assistant-message', noModel)).not.toThrow()
    // Present but invalid still fails closed.
    expect(() =>
      validateChatDbRequest('chatdb:regenerate-assistant-message', { ...noModel, currentModel: { id: '' } })
    ).toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:regenerate-assistant-message', { ...noModel, currentModel: null })
    ).toThrow()
    // Resend keeps currentModel required.
    const resendNoModel = { topicId: 't-1', userMessageId: 'u-1', assistantId: 'a-1' }
    expect(() => validateChatDbRequest('chatdb:resend-user-messages', resendNoModel)).toThrow()
  })

  it('branchId is optional route: absent/null/valid accept, empty rejects', () => {
    const resendBase = validResendRequest()
    const regenBase = validRegenRequest()
    // Absent addresses the main route.
    expect(() => validateChatDbRequest('chatdb:resend-user-messages', resendBase)).not.toThrow()
    expect(() => validateChatDbRequest('chatdb:regenerate-assistant-message', regenBase)).not.toThrow()
    // Explicit null also addresses the main route; an explicit undefined own
    // prop fails closed via JSON safety.
    expect(() => validateChatDbRequest('chatdb:resend-user-messages', { ...resendBase, branchId: undefined })).toThrow()
    expect(() => validateChatDbRequest('chatdb:resend-user-messages', { ...resendBase, branchId: null })).not.toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:regenerate-assistant-message', { ...regenBase, branchId: null })
    ).not.toThrow()
    // Non-empty branch node id is a valid explicit route.
    expect(() => validateChatDbRequest('chatdb:resend-user-messages', { ...resendBase, branchId: 'b-1' })).not.toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:regenerate-assistant-message', { ...regenBase, branchId: 'b-1' })
    ).not.toThrow()
    // Empty string is never a valid route.
    expect(() => validateChatDbRequest('chatdb:resend-user-messages', { ...resendBase, branchId: '' })).toThrow()
    expect(() => validateChatDbRequest('chatdb:regenerate-assistant-message', { ...regenBase, branchId: '' })).toThrow()
  })

  it('strict snapshot: id-only and partial currentModel reject, full+extra accept', () => {
    const resendBase = { topicId: 't-1', userMessageId: 'u-1', assistantId: 'a-1' }
    // id-only must fail closed (never becomes an execution model).
    expect(() =>
      validateChatDbRequest('chatdb:resend-user-messages', { ...resendBase, currentModel: { id: 'm-1' } })
    ).toThrow()
    // Each missing required field fails, including empty strings.
    for (const partial of [
      { id: 'm-1', provider: 'openai', name: 'gpt' },
      { id: 'm-1', provider: 'openai', group: 'g' },
      { id: 'm-1', name: 'gpt', group: 'g' },
      { id: 'm-1', provider: '', name: 'gpt', group: 'g' },
      { id: 'm-1', provider: 'openai', name: 'gpt', group: '' }
    ]) {
      expect(() =>
        validateChatDbRequest('chatdb:resend-user-messages', { ...resendBase, currentModel: partial })
      ).toThrow()
      expect(() =>
        validateChatDbRequest('chatdb:regenerate-assistant-message', {
          topicId: 't-1',
          assistantMessageId: 'a-1',
          assistantId: 'as-1',
          currentModel: partial
        })
      ).toThrow()
    }
    // Full + extra JSON keys (capabilities etc.) pass through verbatim.
    const fullExtra = { id: 'm-1', provider: 'openai', name: 'gpt', group: 'g', capabilities: [{ type: 'vision' }] }
    expect(() =>
      validateChatDbRequest('chatdb:resend-user-messages', { ...resendBase, currentModel: fullExtra })
    ).not.toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:regenerate-assistant-message', {
        topicId: 't-1',
        assistantMessageId: 'a-1',
        assistantId: 'as-1',
        currentModel: fullExtra
      })
    ).not.toThrow()
  })
})
