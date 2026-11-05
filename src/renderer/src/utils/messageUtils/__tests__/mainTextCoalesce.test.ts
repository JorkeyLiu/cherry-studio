import type { MainTextMessageBlock, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus, MessageBlockType } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import { coalesceAdjacentMainTextBlocks, joinMainTextContents } from '../mainTextCoalesce'

const mainText = (id: string, content: string, overrides: Partial<MainTextMessageBlock> = {}): MessageBlock =>
  ({
    id,
    messageId: 'message-1',
    type: MessageBlockType.MAIN_TEXT,
    content,
    status: MessageBlockStatus.SUCCESS,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }) as MessageBlock

const thinking = (id: string, content = 'reasoning'): MessageBlock =>
  ({
    id,
    messageId: 'message-1',
    type: MessageBlockType.THINKING,
    content,
    thinking_millsec: 120,
    status: MessageBlockStatus.SUCCESS,
    createdAt: '2026-01-01T00:00:00.000Z'
  }) as MessageBlock

const tool = (id: string): MessageBlock =>
  ({
    id,
    messageId: 'message-1',
    type: MessageBlockType.TOOL,
    content: '42',
    status: MessageBlockStatus.SUCCESS,
    createdAt: '2026-01-01T00:00:00.000Z'
  }) as MessageBlock

const ids = (blocks: readonly MessageBlock[]) => blocks.map((block) => block.id)

describe('coalesceAdjacentMainTextBlocks', () => {
  it('returns an empty list for an empty message', () => {
    expect(coalesceAdjacentMainTextBlocks([])).toEqual([])
  })

  it('folds a run of adjacent main-text blocks into the first block, joined with the canonical separator', () => {
    const result = coalesceAdjacentMainTextBlocks([
      mainText('t1', 'first stored part'),
      mainText('t2', 'second stored part')
    ])

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('t1')
    expect((result[0] as MainTextMessageBlock).content).toBe('first stored part\n\nsecond stored part')
  })

  it('folds a run of three or more blocks into one survivor', () => {
    const result = coalesceAdjacentMainTextBlocks([
      mainText('t1', 'one'),
      mainText('t2', 'two'),
      mainText('t3', 'three')
    ])

    expect(ids(result)).toEqual(['t1'])
    expect((result[0] as MainTextMessageBlock).content).toBe(joinMainTextContents(['one', 'two', 'three']))
  })

  it('is a no-op for a single main-text block, keeping the same reference', () => {
    const block = mainText('t1', 'only part')
    const result = coalesceAdjacentMainTextBlocks([block])

    expect(result).toHaveLength(1)
    expect(result[0]).toBe(block)
  })

  it('is a no-op for a message with no main-text blocks', () => {
    const blocks = [thinking('th1'), tool('tool1')]
    const result = coalesceAdjacentMainTextBlocks(blocks)

    expect(ids(result)).toEqual(['th1', 'tool1'])
    expect(result[0]).toBe(blocks[0])
    expect(result[1]).toBe(blocks[1])
  })

  it('never folds across a non-main-text block and keeps overall order', () => {
    const result = coalesceAdjacentMainTextBlocks([mainText('t1', 'before'), thinking('th1'), mainText('t2', 'after')])

    expect(ids(result)).toEqual(['t1', 'th1', 't2'])
    expect((result[0] as MainTextMessageBlock).content).toBe('before')
    expect((result[2] as MainTextMessageBlock).content).toBe('after')
  })

  it('keeps each separated run independent, with non-text blocks in place', () => {
    const result = coalesceAdjacentMainTextBlocks([
      mainText('t1', 'a'),
      mainText('t2', 'b'),
      tool('tool1'),
      mainText('t3', 'c'),
      mainText('t4', 'd')
    ])

    expect(ids(result)).toEqual(['t1', 'tool1', 't3'])
    expect((result[0] as MainTextMessageBlock).content).toBe('a\n\nb')
    expect((result[2] as MainTextMessageBlock).content).toBe('c\n\nd')
  })

  it('keeps the survivor id and metadata (status/model untouched without run metadata)', () => {
    const result = coalesceAdjacentMainTextBlocks([
      mainText('t1', 'first', { status: MessageBlockStatus.SUCCESS, model: { id: 'model-1' } as never }),
      mainText('t2', 'second', { status: MessageBlockStatus.PAUSED })
    ])

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('t1')
    // The edit-surface path never rewrites the survivor's own status.
    expect(result[0].status).toBe(MessageBlockStatus.SUCCESS)
    expect(result[0].model).toEqual({ id: 'model-1' })
    expect((result[0] as MainTextMessageBlock).citationReferences).toBeUndefined()
  })

  it('never mutates the input blocks', () => {
    const input = [mainText('t1', 'first'), mainText('t2', 'second')]
    coalesceAdjacentMainTextBlocks(input, { preserveRunMetadata: true })

    expect((input[0] as MainTextMessageBlock).content).toBe('first')
    expect(input).toHaveLength(2)
  })

  it('is independent of sortOrder (density is the caller/DB concern)', () => {
    const result = coalesceAdjacentMainTextBlocks([
      mainText('t1', 'first', { sortOrder: 5 } as Partial<MainTextMessageBlock>),
      mainText('t2', 'second', { sortOrder: 9 } as Partial<MainTextMessageBlock>)
    ])

    expect(result).toHaveLength(1)
    expect((result[0] as { sortOrder?: number }).sortOrder).toBe(5)
  })
})

describe('coalesceAdjacentMainTextBlocks with run metadata (finalize path)', () => {
  it('absorbs the folded-away citation references, keeping the survivor first', () => {
    const result = coalesceAdjacentMainTextBlocks(
      [
        mainText('t1', 'first', { citationReferences: [{ citationBlockId: 'cite-1' }] }),
        mainText('t2', 'second', { citationReferences: [{ citationBlockId: 'cite-2' }] })
      ],
      { preserveRunMetadata: true }
    )

    expect(result).toHaveLength(1)
    expect((result[0] as MainTextMessageBlock).citationReferences).toEqual([
      { citationBlockId: 'cite-1' },
      { citationBlockId: 'cite-2' }
    ])
  })

  it('deduplicates repeated citation block ids instead of growing the list', () => {
    const result = coalesceAdjacentMainTextBlocks(
      [
        mainText('t1', 'first', {
          citationReferences: [{ citationBlockId: 'cite-1', citationBlockSource: 'websearch' }]
        }),
        mainText('t2', 'second', { citationReferences: [{ citationBlockId: 'cite-1' }] }),
        mainText('t3', 'third', { citationReferences: [{ citationBlockId: 'cite-2' }] })
      ],
      { preserveRunMetadata: true }
    )

    const references = (result[0] as MainTextMessageBlock).citationReferences
    expect(references).toHaveLength(2)
    // First occurrence wins, so the citation the read path resolves is unchanged.
    expect(references?.[0]).toEqual({ citationBlockId: 'cite-1', citationBlockSource: 'websearch' })
    expect(references?.[1]).toEqual({ citationBlockId: 'cite-2' })
  })

  it('leaves citationReferences absent when no block in the run carries one', () => {
    const result = coalesceAdjacentMainTextBlocks([mainText('t1', 'a'), mainText('t2', 'b')], {
      preserveRunMetadata: true
    })

    expect((result[0] as MainTextMessageBlock).citationReferences).toBeUndefined()
  })

  it('keeps a terminal survivor terminal when every block of the run is terminal', () => {
    const result = coalesceAdjacentMainTextBlocks(
      [
        mainText('t1', 'a', { status: MessageBlockStatus.SUCCESS }),
        mainText('t2', 'b', { status: MessageBlockStatus.SUCCESS })
      ],
      { preserveRunMetadata: true }
    )

    expect(result[0].status).toBe(MessageBlockStatus.SUCCESS)
  })

  it('never marks the survivor terminal when any block of the run is non-terminal', () => {
    const result = coalesceAdjacentMainTextBlocks(
      [
        mainText('t1', 'a', { status: MessageBlockStatus.SUCCESS }),
        mainText('t2', 'b', { status: MessageBlockStatus.STREAMING })
      ],
      { preserveRunMetadata: true }
    )

    expect(result[0].status).toBe(MessageBlockStatus.STREAMING)
  })

  it('takes the least-advanced status when several members are non-terminal', () => {
    const result = coalesceAdjacentMainTextBlocks(
      [
        mainText('t1', 'a', { status: MessageBlockStatus.PAUSED }),
        mainText('t2', 'b', { status: MessageBlockStatus.STREAMING })
      ],
      { preserveRunMetadata: true }
    )

    // First non-terminal member in run order: the run is at least paused, and
    // definitely not terminal.
    expect(result[0].status).toBe(MessageBlockStatus.PAUSED)
  })

  it('accepts ERROR as terminal (no status rewrite)', () => {
    const result = coalesceAdjacentMainTextBlocks(
      [
        mainText('t1', 'a', { status: MessageBlockStatus.ERROR }),
        mainText('t2', 'b', { status: MessageBlockStatus.ERROR })
      ],
      { preserveRunMetadata: true }
    )

    expect(result[0].status).toBe(MessageBlockStatus.ERROR)
  })

  it('does not rewrite status or citations for non-folded blocks', () => {
    const single = mainText('t1', 'only', { status: MessageBlockStatus.STREAMING })
    const result = coalesceAdjacentMainTextBlocks([single, thinking('th1')], { preserveRunMetadata: true })

    expect(result[0]).toBe(single)
    expect(result[0].status).toBe(MessageBlockStatus.STREAMING)
  })
})
