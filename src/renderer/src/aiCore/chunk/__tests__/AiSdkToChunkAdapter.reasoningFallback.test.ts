import { ChunkType } from '@renderer/types/chunk'
import { describe, expect, it, vi } from 'vitest'

import { AiSdkToChunkAdapter } from '../AiSdkToChunkAdapter'

function collectChunks(_action: (adapter: AiSdkToChunkAdapter, emit: (c: any) => void) => void | Promise<void>) {
  void _action
  const chunks: any[] = []
  const onChunk = vi.fn((c) => chunks.push(c))
  const adapter = new AiSdkToChunkAdapter(onChunk, [], false, false)
  // Access private method via bracket
  const final = {
    text: '',
    reasoningContent: '',
    webSearchResults: [],
    reasoningId: '',
    providerMetadata: undefined as any
  }
  const convert = (adapter as any).convertAndEmitChunk.bind(adapter)
  return { chunks, onChunk, adapter, final, convert }
}

describe('AiSdkToChunkAdapter reasoning fallback', () => {
  it('reasoning-start + delta then finish should emit THINKING_COMPLETE before BLOCK_COMPLETE', () => {
    const { chunks, convert, final } = collectChunks(() => {})
    convert({ type: 'reasoning-start', id: 'r1' } as any, final)
    convert({ type: 'reasoning-delta', text: 'hello thinking' } as any, final)
    // no reasoning-end, no text-start
    convert({ type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as any, final)
    const types = chunks.map((c) => c.type)
    expect(types).toContain(ChunkType.THINKING_START)
    expect(types).toContain(ChunkType.THINKING_DELTA)
    // THINKING_COMPLETE must appear before BLOCK_COMPLETE
    const thinkingCompleteIdx = types.indexOf(ChunkType.THINKING_COMPLETE)
    const blockCompleteIdx = types.indexOf(ChunkType.BLOCK_COMPLETE)
    expect(thinkingCompleteIdx).toBeGreaterThan(-1)
    expect(blockCompleteIdx).toBeGreaterThan(-1)
    expect(thinkingCompleteIdx).toBeLessThan(blockCompleteIdx)
    const thinkingComplete = chunks[thinkingCompleteIdx]
    expect(thinkingComplete.text).toBe('hello thinking')
    // ensure final.reasoningContent cleared after finish (no double source)
    expect(final.reasoningContent).toBe('')
  })

  it('reasoning-start alone then finish without content should still complete thinking', () => {
    const { chunks, convert, final } = collectChunks(() => {})
    convert({ type: 'reasoning-start', id: 'r2' } as any, final)
    convert({ type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as any, final)
    const types = chunks.map((c) => c.type)
    expect(types).toContain(ChunkType.THINKING_COMPLETE)
    const tc = chunks.find((c) => c.type === ChunkType.THINKING_COMPLETE)
    expect(tc.text).toBe('')
  })

  it('reasoning without end but with finish-step should complete once and not double on finish', () => {
    const { chunks, convert, final } = collectChunks(() => {})
    convert({ type: 'reasoning-start', id: 'r3' } as any, final)
    convert({ type: 'reasoning-delta', text: 'step thinking' } as any, final)
    convert({ type: 'finish-step', providerMetadata: {}, finishReason: 'stop' } as any, final)
    convert({ type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as any, final)
    const thinkingCompletes = chunks.filter((c) => c.type === ChunkType.THINKING_COMPLETE)
    expect(thinkingCompletes).toHaveLength(1)
    expect(thinkingCompletes[0].text).toBe('step thinking')
  })

  it('normal reasoning-end should not be doubled by finish fallback', () => {
    const { chunks, convert, final } = collectChunks(() => {})
    convert({ type: 'reasoning-start', id: 'r4' } as any, final)
    convert({ type: 'reasoning-delta', text: 'content' } as any, final)
    convert({ type: 'reasoning-end' } as any, final)
    // reset count after normal complete
    const beforeFinishCount = chunks.filter((c) => c.type === ChunkType.THINKING_COMPLETE).length
    expect(beforeFinishCount).toBe(1)
    convert({ type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as any, final)
    const after = chunks.filter((c) => c.type === ChunkType.THINKING_COMPLETE).length
    expect(after).toBe(1)
  })

  it('text-start should still close pending reasoning before text', () => {
    const { chunks, convert, final } = collectChunks(() => {})
    convert({ type: 'reasoning-start', id: 'r5' } as any, final)
    convert({ type: 'reasoning-delta', text: 'think' } as any, final)
    convert({ type: 'text-start' } as any, final)
    const types = chunks.map((c) => c.type)
    const tcIdx = types.indexOf(ChunkType.THINKING_COMPLETE)
    const textStartIdx = types.indexOf(ChunkType.TEXT_START)
    expect(tcIdx).toBeGreaterThan(-1)
    expect(tcIdx).toBeLessThan(textStartIdx)
    // finish after text should not emit another THINKING_COMPLETE
    convert({ type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as any, final)
    expect(chunks.filter((c) => c.type === ChunkType.THINKING_COMPLETE)).toHaveLength(1)
  })
})
