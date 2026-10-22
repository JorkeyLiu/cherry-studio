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

  it('accepts and validates the optional context-anchor inheritance input', () => {
    const contract = getContract('chatdb:move-selected-turns-to-new-branch')
    const base = { topicId: 't1', selectedGroupIds: ['uB'], expectedSelectedMessageIds: ['uB'] }
    expect(() => contract.validate({ ...base, contextAnchorInheritance: {} })).not.toThrow()
    expect(() =>
      contract.validate({ ...base, contextAnchorInheritance: { sourceAnchorGroupKey: null, contextCount: null } })
    ).not.toThrow()
    expect(() =>
      contract.validate({ ...base, contextAnchorInheritance: { sourceAnchorGroupKey: 'uA', contextCount: 25 } })
    ).not.toThrow()
    // Rejections: unknown nested key, empty anchor key, non-finite count,
    // non-object input.
    expect(() =>
      contract.validate({ ...base, contextAnchorInheritance: { sourceAnchorGroupKey: 'uA', extra: 1 } })
    ).toThrow()
    expect(() => contract.validate({ ...base, contextAnchorInheritance: { sourceAnchorGroupKey: '' } })).toThrow()
    expect(() => contract.validate({ ...base, contextAnchorInheritance: { contextCount: Number.NaN } })).toThrow()
    expect(() => contract.validate({ ...base, contextAnchorInheritance: 'nope' })).toThrow()
  })

  it('accepts an absent, null, or non-empty resolvedContextAnchorGroupKey and rejects an empty one', () => {
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
    const value = {
      branch,
      movedMessageIds: ['uB'],
      anchorMessageId: 'aA',
      parentMessages: [],
      parentBlocks: [],
      messages: [],
      blocks: []
    }
    expect(() => contract.validateResult({ ok: true, value: { ...value } })).not.toThrow()
    expect(() =>
      contract.validateResult({ ok: true, value: { ...value, resolvedContextAnchorGroupKey: null } })
    ).not.toThrow()
    expect(() =>
      contract.validateResult({ ok: true, value: { ...value, resolvedContextAnchorGroupKey: 'uA' } })
    ).not.toThrow()
    expect(() =>
      contract.validateResult({ ok: true, value: { ...value, resolvedContextAnchorGroupKey: '' } })
    ).toThrow()
    expect(() => contract.validateResult({ ok: true, value: { ...value, resolvedContextAnchorGroupKey: 7 } })).toThrow()
  })

  it('validates the optional source-route anchor transfer fact', () => {
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
    const value = {
      branch,
      movedMessageIds: ['uB'],
      anchorMessageId: 'aA',
      parentMessages: [],
      parentBlocks: [],
      messages: [],
      blocks: [],
      resolvedContextAnchorGroupKey: 'uB'
    }
    expect(() =>
      contract.validateResult({
        ok: true,
        value: { ...value, sourceContextAnchorTransfer: { fromGroupKey: 'uB', toGroupKey: 'uA' } }
      })
    ).not.toThrow()
    // Empty source route: an explicitly nullable replacement key.
    expect(() =>
      contract.validateResult({
        ok: true,
        value: { ...value, sourceContextAnchorTransfer: { fromGroupKey: 'uB', toGroupKey: null } }
      })
    ).not.toThrow()
    // Rejections: empty from/to keys, unknown nested key, non-object.
    expect(() =>
      contract.validateResult({
        ok: true,
        value: { ...value, sourceContextAnchorTransfer: { fromGroupKey: '', toGroupKey: 'uA' } }
      })
    ).toThrow()
    expect(() =>
      contract.validateResult({
        ok: true,
        value: { ...value, sourceContextAnchorTransfer: { fromGroupKey: 'uB', toGroupKey: '' } }
      })
    ).toThrow()
    expect(() =>
      contract.validateResult({
        ok: true,
        value: { ...value, sourceContextAnchorTransfer: { fromGroupKey: 'uB', toGroupKey: 'uA', extra: 1 } }
      })
    ).toThrow()
    expect(() =>
      contract.validateResult({ ok: true, value: { ...value, sourceContextAnchorTransfer: 'nope' } })
    ).toThrow()
  })
})
