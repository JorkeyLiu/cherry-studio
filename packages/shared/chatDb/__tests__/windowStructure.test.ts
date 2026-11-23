import { describe, expect, it } from 'vitest'

import { validateChatDbRequest, validateChatDbResult, ValidationError } from '../index'

const baseWindow = {
  kind: 'latest' as const,
  completeness: 'window' as const,
  topicId: 't1',
  anchorMessageId: null,
  requested: { limit: 10 },
  firstMessageId: 'm1',
  lastMessageId: 'm1',
  returnedCount: 1,
  hasMoreBefore: false,
  hasMoreAfter: false
}

const baseSuccess = {
  ok: true as const,
  value: {
    messages: [{ id: 'm1' }],
    blocks: [{ id: 'b1', messageId: 'm1' }],
    mutableMessageIds: ['m1'],
    window: baseWindow
  }
}

function seg(id: string, mids: string[]) {
  return {
    id,
    topicId: 't1',
    name: `seg-${id}`,
    messageIds: mids,
    headerMessageId: mids.length > 0 ? mids[0] : null,
    ownerTopicId: 't1',
    ownerBranchId: null,
    createdAt: null,
    updatedAt: null,
    sortOrder: 0,
    firstMessageId: mids.length > 0 ? mids[0] : null,
    lastMessageId: mids.length > 0 ? mids[mids.length - 1] : null,
    messageCount: mids.length
  }
}

function withStructure(extra: Record<string, unknown>) {
  return {
    ok: true as const,
    value: {
      ...baseSuccess.value,
      ...extra
    }
  }
}

describe('window bundled structure — request contract', () => {
  it('accepts includeStructure true/false/omitted on latest and around', () => {
    expect(() =>
      validateChatDbRequest('chatdb:fetch-messages-window', { kind: 'latest', topicId: 't1', limit: 10 })
    ).not.toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:fetch-messages-window', {
        kind: 'latest',
        topicId: 't1',
        limit: 10,
        includeStructure: true
      })
    ).not.toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:fetch-messages-window', {
        kind: 'latest',
        topicId: 't1',
        limit: 10,
        includeStructure: false
      })
    ).not.toThrow()
    expect(() =>
      validateChatDbRequest('chatdb:fetch-messages-window', {
        kind: 'around',
        topicId: 't1',
        anchorMessageId: 'm1',
        before: 5,
        after: 5,
        includeStructure: true
      })
    ).not.toThrow()
  })
  it('rejects non-boolean includeStructure', () => {
    for (const bad of [1, 0, 'true', null, {}, []]) {
      expect(() =>
        validateChatDbRequest('chatdb:fetch-messages-window', {
          kind: 'latest',
          topicId: 't1',
          limit: 10,
          includeStructure: bad
        } as any)
      ).toThrow(ValidationError)
    }
  })
})

describe('window bundled structure — result contract', () => {
  it('accepts lightweight window without structure (default old callers)', () => {
    expect(() => validateChatDbResult('chatdb:fetch-messages-window', baseSuccess)).not.toThrow()
  })
  it('accepts valid bundled structure with echo and empty-subset qualification', () => {
    const ok = withStructure({
      structure: {
        catalog: [seg('s1', ['m1', 'm2']), seg('s2', [])],
        route: {
          topicId: 't1',
          branchId: null,
          qualifications: [
            { segmentId: 's1', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m1'] },
            { segmentId: 's2', headerInRoute: false, headerOwnedByRoute: false, routeMemberMessageIds: [] }
          ]
        }
      }
    })
    expect(() => validateChatDbResult('chatdb:fetch-messages-window', ok)).not.toThrow()
  })
  it('accepts empty catalog as known-empty (zero qualifications)', () => {
    const ok = withStructure({
      structure: { catalog: [], route: { topicId: 't1', branchId: null, qualifications: [] } }
    })
    expect(() => validateChatDbResult('chatdb:fetch-messages-window', ok)).not.toThrow()
  })
  it('rejects catalog entries carrying route (must stay neutral)', () => {
    const bad = withStructure({
      structure: {
        catalog: [
          {
            ...seg('s1', ['m1']),
            route: {
              topicId: 't1',
              branchId: null,
              headerInRoute: true,
              headerOwnedByRoute: true,
              routeMemberMessageIds: ['m1']
            }
          }
        ],
        route: {
          topicId: 't1',
          branchId: null,
          qualifications: [
            { segmentId: 's1', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m1'] }
          ]
        }
      }
    })
    expect(() => validateChatDbResult('chatdb:fetch-messages-window', bad)).toThrow(ValidationError)
  })
  it('rejects duplicate catalog ids and duplicate qualifications', () => {
    const dupCatalog = withStructure({
      structure: {
        catalog: [seg('s1', ['m1']), seg('s1', ['m1'])],
        route: {
          topicId: 't1',
          branchId: null,
          qualifications: [
            { segmentId: 's1', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m1'] }
          ]
        }
      }
    })
    expect(() => validateChatDbResult('chatdb:fetch-messages-window', dupCatalog)).toThrow(ValidationError)
    const dupQual = withStructure({
      structure: {
        catalog: [seg('s1', ['m1'])],
        route: {
          topicId: 't1',
          branchId: null,
          qualifications: [
            { segmentId: 's1', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m1'] },
            { segmentId: 's1', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m1'] }
          ]
        }
      }
    })
    expect(() => validateChatDbResult('chatdb:fetch-messages-window', dupQual)).toThrow(ValidationError)
  })
  it('rejects foreign qualification and route member outside the catalog', () => {
    const foreign = withStructure({
      structure: {
        catalog: [seg('s1', ['m1'])],
        route: {
          topicId: 't1',
          branchId: null,
          qualifications: [
            { segmentId: 'nope', headerInRoute: false, headerOwnedByRoute: false, routeMemberMessageIds: [] }
          ]
        }
      }
    })
    expect(() => validateChatDbResult('chatdb:fetch-messages-window', foreign)).toThrow(ValidationError)
    const outside = withStructure({
      structure: {
        catalog: [seg('s1', ['m1'])],
        route: {
          topicId: 't1',
          branchId: null,
          qualifications: [
            { segmentId: 's1', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['mx'] }
          ]
        }
      }
    })
    expect(() => validateChatDbResult('chatdb:fetch-messages-window', outside)).toThrow(ValidationError)
  })
  it('branch echo has no request context at the result boundary (caller guard pairs it)', () => {
    // The response carries no addressed branchId outside structure.route, so
    // a branch echo cannot be checked here the way the topic echo is checked
    // against window.topicId. Any well-formed branch echo validates; pairing
    // it with the requested route is the renderer caller guard
    // (projectCommittedChromeFromStructure rejects echo mismatch, covered in
    // routeCommittedChrome.structure.test.ts).
    for (const branchId of ['b-other', null]) {
      const res = withStructure({
        structure: {
          catalog: [seg('s1', ['m1'])],
          route: {
            topicId: 't1',
            branchId,
            qualifications: [
              { segmentId: 's1', headerInRoute: true, headerOwnedByRoute: false, routeMemberMessageIds: ['m1'] }
            ]
          }
        }
      })
      expect(() => validateChatDbResult('chatdb:fetch-messages-window', res)).not.toThrow()
    }
  })
  it('rejects route topic echo mismatch and coverage mismatch', () => {
    const echo = withStructure({
      structure: {
        catalog: [seg('s1', ['m1'])],
        route: {
          topicId: 'other',
          branchId: null,
          qualifications: [
            { segmentId: 's1', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m1'] }
          ]
        }
      }
    })
    expect(() => validateChatDbResult('chatdb:fetch-messages-window', echo)).toThrow(ValidationError)
    const missing = withStructure({
      structure: {
        catalog: [seg('s1', ['m1']), seg('s2', ['m2'])],
        route: {
          topicId: 't1',
          branchId: null,
          qualifications: [
            { segmentId: 's1', headerInRoute: true, headerOwnedByRoute: true, routeMemberMessageIds: ['m1'] }
          ]
        }
      }
    })
    expect(() => validateChatDbResult('chatdb:fetch-messages-window', missing)).toThrow(ValidationError)
  })
})
