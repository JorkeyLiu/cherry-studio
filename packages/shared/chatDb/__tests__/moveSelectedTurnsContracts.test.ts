import { describe, expect, it } from 'vitest'

import { getContract } from '../contracts'

describe('move-selected-turns-to-new-branch contract', () => {
  it('accepts a minimal valid request', () => {
    const contract = getContract('chatdb:move-selected-turns-to-new-branch')
    expect(() =>
      contract.validate({
        topicId: 't1',
        sourceBranchId: null,
        selectedGroupIds: ['uB', 'uC'],
        expectedSelectedMessageIds: ['uB', 'aB', 'uC', 'aC'],
        name: 'Moved'
      })
    ).not.toThrow()
  })

  it('rejects empty group IDs and unknown keys', () => {
    const contract = getContract('chatdb:move-selected-turns-to-new-branch')
    expect(() =>
      contract.validate({ topicId: 't1', selectedGroupIds: [], expectedSelectedMessageIds: ['uB'] })
    ).toThrow()
    expect(() =>
      contract.validate({
        topicId: 't1',
        selectedGroupIds: ['uB'],
        expectedSelectedMessageIds: ['uB'],
        extra: 1
      } as unknown as Record<string, unknown>)
    ).toThrow()
  })

  it('rejects missing/empty expectedSelectedMessageIds', () => {
    const contract = getContract('chatdb:move-selected-turns-to-new-branch')
    expect(() => contract.validate({ topicId: 't1', selectedGroupIds: ['uB'] })).toThrow()
    expect(() =>
      contract.validate({ topicId: 't1', selectedGroupIds: ['uB'], expectedSelectedMessageIds: [] })
    ).toThrow()
    expect(() =>
      contract.validate({ topicId: 't1', selectedGroupIds: ['uB'], expectedSelectedMessageIds: [''] })
    ).toThrow()
  })

  it('validates a success envelope with the exact value keys', () => {
    const contract = getContract('chatdb:move-selected-turns-to-new-branch')
    const branch = {
      id: 'b1',
      topicId: 't1',
      parentBranchId: null,
      anchorMessageId: 'aA',
      name: 'Moved',
      createdAt: null,
      updatedAt: null
    }
    expect(() =>
      contract.validateResult({
        ok: true,
        value: {
          branch,
          movedMessageIds: ['uB'],
          anchorMessageId: 'aA',
          parentMessages: [],
          parentBlocks: [],
          messages: [],
          blocks: []
        }
      })
    ).not.toThrow()
    expect(() =>
      contract.validateResult({
        ok: true,
        value: {
          branch,
          movedMessageIds: ['uB'],
          anchorMessageId: 'aA',
          parentMessages: [],
          parentBlocks: [],
          messages: [],
          blocks: [],
          extra: 1
        }
      })
    ).toThrow()
  })
})
