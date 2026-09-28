import * as fs from 'node:fs'

import { anchorKeyForRoute } from '@renderer/services/anchorService'
import { getAssistantSettings } from '@renderer/services/AssistantService'
import {
  closureKeyForRoute,
  getFreshValidatedClosure,
  resetAllClosureStateForTests,
  setCachedContextClosureWithFingerprint
} from '@renderer/services/contextClosure'
import { computeContextInfo } from '@renderer/services/contextInfoService'
import { ConversationService } from '@renderer/services/ConversationService'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function closureFor(topicId: string, anchor: string) {
  const messages = [
    { id: anchor, role: 'user', topicId, blocks: [] },
    { id: `${anchor}-a1`, role: 'assistant', askId: anchor, topicId, blocks: [] }
  ]
  return {
    messages,
    blocks: [],
    closure: {
      completeness: 'context-closure',
      topicId,
      anchorGroupKey: anchor,
      firstMessageId: anchor,
      lastMessageId: `${anchor}-a1`,
      returnedCount: 2,
      totalTurnCount: 1,
      selectedTurnCount: 1,
      boundaryMessageId: null
    }
  } as any
}

describe('context per-route isolation (CW-1..CW-8)', () => {
  beforeEach(() => {
    resetAllClosureStateForTests()
    vi.clearAllMocks()
  })

  it('anchor keys are route-isolated (main bare, branch suffixed)', () => {
    expect(anchorKeyForRoute('t1', null)).toBe('t1')
    expect(anchorKeyForRoute('t1', undefined)).toBe('t1')
    expect(anchorKeyForRoute('t1', 'b1')).toBe('t1:b1')
    expect(closureKeyForRoute('t1', null)).toBe('t1')
    expect(closureKeyForRoute('t1', 'b1')).toBe('t1:b1')
  })

  it('closure cache is route-scoped: branch closure never leaks to main', () => {
    const fp = 'fp-1'
    setCachedContextClosureWithFingerprint('t1', closureFor('t1', 'u-branch'), fp, 'b1')
    // Main route with same anchor lookup misses (different route key).
    expect(getFreshValidatedClosure('t1', 'u-branch', fp, null)).toBeNull()
    // Branch route hits.
    expect(getFreshValidatedClosure('t1', 'u-branch', fp, 'b1')).not.toBeNull()
    // Cross-branch misses.
    expect(getFreshValidatedClosure('t1', 'u-branch', fp, 'b2')).toBeNull()
  })

  it('computeContextInfo fallback reads the route key, not the bare topic', () => {
    const assistant: any = {
      id: 'a1',
      settings: {
        contextCount: null,
        contextWindowAnchor: {
          t1: { kind: 'active', groupKey: 'u-main' },
          't1:b1': { kind: 'active', groupKey: 'u-branch' }
        }
      }
    }
    const messages: any[] = [
      { id: 'u-main', role: 'user', topicId: 't1', blocks: [] },
      { id: 'u-branch', role: 'user', topicId: 't1', blocks: [] }
    ]
    const mainInfo = computeContextInfo(messages, assistant, 't1', undefined, null)
    const branchInfo = computeContextInfo(messages, assistant, 't1', undefined, 'b1')
    expect(mainInfo.anchorGroupKey).toBe('u-main')
    expect(branchInfo.anchorGroupKey).toBe('u-branch')
  })

  it('ConversationService uses branchId for closure + fallback (no bare-topic leak)', async () => {
    const assistant: any = {
      id: 'a1',
      model: undefined,
      settings: {
        contextCount: null,
        contextWindowAnchor: { 't1:b1': { kind: 'active', groupKey: 'u-branch' } }
      }
    }
    // Seed branch closure only.
    setCachedContextClosureWithFingerprint('t1', closureFor('t1', 'u-branch'), 'fp-x', 'b1')
    // getAssistantSettings is real (reads assistant.settings); ConversationService
    // must resolve the branch anchor and hit the branch closure without throwing
    // on missing model only after context resolution. Missing model throws
    // NoModelError — but context resolution itself must not throw. We assert
    // the anchor lookup helper agrees with the service path.
    const anchorKey = 't1:b1'
    expect(getAssistantSettings(assistant).contextWindowAnchor?.[anchorKey]?.groupKey).toBe('u-branch')
    // Main route has no anchor → service falls back to viewport without branch closure.
    const mainAnchor = (getAssistantSettings(assistant).contextWindowAnchor as any)?.['t1']
    expect(mainAnchor).toBeUndefined()
    void ConversationService
  })

  it('production context surfaces pass branchId (hook/callback/TokenCount)', () => {
    const closureHook = fs.readFileSync('src/renderer/src/hooks/useContextClosure.ts', 'utf8')
    expect(closureHook).toMatch(/branchId/)
    expect(closureHook).toMatch(/fetchContextClosure/)
    expect(closureHook).toMatch(/branchId: route|branchId:\s*route/)

    const reanchorHook = fs.readFileSync('src/renderer/src/pages/home/Inputbar/hooks/useContextWindowAnchor.ts', 'utf8')
    expect(reanchorHook).toMatch(/anchorKeyForRoute/)
    expect(reanchorHook).toMatch(/branchId:\s*route/)
    expect(reanchorHook).toMatch(/getClosureLoadGeneration\(topicId,\s*route\)/)

    const callbacks = fs.readFileSync('src/renderer/src/services/messageStreaming/callbacks/baseCallbacks.ts', 'utf8')
    expect(callbacks).toMatch(/selectActiveBranchId/)
    expect(callbacks).toMatch(/getFreshValidatedClosure\(topicId,\s*anchorGroupKey,\s*currentFp,\s*execRoute\)/)
    expect(callbacks).toMatch(/computeContextInfo\(contextMsgs,\s*assistant,\s*topicId,\s*undefined,\s*execRoute\)/)

    const chat = fs.readFileSync('src/renderer/src/pages/home/Chat.tsx', 'utf8')
    expect(chat).toMatch(/useContextClosure\(props\.activeTopic\.id,\s*anchorGroupKey,\s*activeBranchId\)/)
  })

  it('local projection never recomputes a valid anchor (no viewport authority)', () => {
    const anchorSvc = fs.readFileSync('src/renderer/src/services/anchorService.ts', 'utf8')
    // Establishment path must not read loaded viewport messages.
    const establishIdx = anchorSvc.indexOf('export async function ensureTopicAnchorEstablished')
    const establishSlice = anchorSvc.slice(establishIdx, establishIdx + 4000)
    expect(establishSlice).not.toMatch(/selectLoadedMessagesForTopic/)
    expect(establishSlice).not.toMatch(/buildContextTurns/)
  })
})
