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

function makeStream(parts: any[]): ReadableStream<any> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p)
      controller.close()
    }
  })
}

async function drainThroughReadFullStream(parts: any[]) {
  const chunks: any[] = []
  const adapter = new AiSdkToChunkAdapter((c) => chunks.push(c), [], false, false)
  await (adapter as any).readFullStream(makeStream(parts))
  return chunks
}

describe('AiSdkToChunkAdapter reasoning fallback', () => {
  it('reasoning-start + delta then finish should emit THINKING_COMPLETE before BLOCK_COMPLETE', () => {
    const { chunks, convert, final } = collectChunks(() => {})
    convert({ type: 'reasoning-start', id: 'r1' } as any, final)
    // START is delayed until first visible delta
    expect(chunks.map((c) => c.type)).not.toContain(ChunkType.THINKING_START)
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

  it('reasoning-start alone then finish without content emits no thinking chunks', () => {
    const { chunks, convert, final } = collectChunks(() => {})
    convert({ type: 'reasoning-start', id: 'r2' } as any, final)
    // No visible text yet: no shell
    expect(chunks.map((c) => c.type)).not.toContain(ChunkType.THINKING_START)
    convert({ type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as any, final)
    const types = chunks.map((c) => c.type)
    expect(types).not.toContain(ChunkType.THINKING_START)
    expect(types).not.toContain(ChunkType.THINKING_DELTA)
    expect(types).not.toContain(ChunkType.THINKING_COMPLETE)
    expect(types).toContain(ChunkType.BLOCK_COMPLETE)
    expect(final.reasoningContent).toBe('')
  })

  it('empty start/end/finish emits no thinking shell', () => {
    const { chunks, convert, final } = collectChunks(() => {})
    convert({ type: 'reasoning-start', id: 'r-empty' } as any, final)
    convert({ type: 'reasoning-end' } as any, final)
    convert({ type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as any, final)
    const types = chunks.map((c) => c.type)
    expect(types).not.toContain(ChunkType.THINKING_START)
    expect(types).not.toContain(ChunkType.THINKING_DELTA)
    expect(types).not.toContain(ChunkType.THINKING_COMPLETE)
    expect(types).toContain(ChunkType.BLOCK_COMPLETE)
    expect(types).toContain(ChunkType.LLM_RESPONSE_COMPLETE)
  })

  it('empty and whitespace-only deltas never start visible thinking', () => {
    const { chunks, convert, final } = collectChunks(() => {})
    convert({ type: 'reasoning-start', id: 'r-ws' } as any, final)
    convert({ type: 'reasoning-delta', text: '' } as any, final)
    convert({ type: 'reasoning-delta', text: '   \n\t  ' } as any, final)
    expect(chunks.map((c) => c.type)).not.toContain(ChunkType.THINKING_START)
    expect(chunks.map((c) => c.type)).not.toContain(ChunkType.THINKING_DELTA)
    convert({ type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as any, final)
    const types = chunks.map((c) => c.type)
    expect(types).not.toContain(ChunkType.THINKING_START)
    expect(types).not.toContain(ChunkType.THINKING_DELTA)
    expect(types).not.toContain(ChunkType.THINKING_COMPLETE)
    expect(final.reasoningContent).toBe('')
  })

  it('delayed real delta starts thinking once and preserves leading whitespace', () => {
    const { chunks, convert, final } = collectChunks(() => {})
    convert({ type: 'reasoning-start', id: 'r-delayed' } as any, final)
    convert({ type: 'reasoning-delta', text: '   ' } as any, final)
    convert({ type: 'reasoning-delta', text: '\n' } as any, final)
    expect(chunks.filter((c) => c.type === ChunkType.THINKING_START)).toHaveLength(0)
    convert({ type: 'reasoning-delta', text: 'hello' } as any, final)
    const starts = chunks.filter((c) => c.type === ChunkType.THINKING_START)
    expect(starts).toHaveLength(1)
    const deltas = chunks.filter((c) => c.type === ChunkType.THINKING_DELTA)
    expect(deltas).toHaveLength(1)
    // Raw whitespace is preserved in the accumulated thinking text
    expect(deltas[0].text).toBe('   \nhello')
    convert({ type: 'reasoning-delta', text: ' world' } as any, final)
    expect(chunks.filter((c) => c.type === ChunkType.THINKING_START)).toHaveLength(1)
    expect(chunks.filter((c) => c.type === ChunkType.THINKING_DELTA)).toHaveLength(2)
    convert({ type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as any, final)
    const completes = chunks.filter((c) => c.type === ChunkType.THINKING_COMPLETE)
    expect(completes).toHaveLength(1)
    expect(completes[0].text).toBe('   \nhello world')
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

  it('pending empty reasoning closed silently by text-start without thinking complete', () => {
    const { chunks, convert, final } = collectChunks(() => {})
    convert({ type: 'reasoning-start', id: 'r-pending-ws' } as any, final)
    convert({ type: 'reasoning-delta', text: '  ' } as any, final)
    convert({ type: 'text-start' } as any, final)
    const types = chunks.map((c) => c.type)
    expect(types).not.toContain(ChunkType.THINKING_START)
    expect(types).not.toContain(ChunkType.THINKING_COMPLETE)
    expect(types).toContain(ChunkType.TEXT_START)
    expect(final.reasoningContent).toBe('')
  })

  it('EOF without finish converges visible thinking and emits exactly one completion', async () => {
    const chunks = await drainThroughReadFullStream([
      { type: 'reasoning-start', id: 'r-eof' },
      { type: 'reasoning-delta', text: 'eof thinking' }
    ])
    const types = chunks.map((c) => c.type)
    expect(types).toContain(ChunkType.THINKING_START)
    expect(types).toContain(ChunkType.THINKING_DELTA)
    expect(types).toContain(ChunkType.THINKING_COMPLETE)
    expect(chunks.filter((c) => c.type === ChunkType.BLOCK_COMPLETE)).toHaveLength(1)
    expect(chunks.filter((c) => c.type === ChunkType.LLM_RESPONSE_COMPLETE)).toHaveLength(1)
    const tcIdx = types.indexOf(ChunkType.THINKING_COMPLETE)
    const bcIdx = types.indexOf(ChunkType.BLOCK_COMPLETE)
    const lrIdx = types.indexOf(ChunkType.LLM_RESPONSE_COMPLETE)
    expect(tcIdx).toBeLessThan(bcIdx)
    expect(bcIdx).toBeLessThan(lrIdx)
    expect(chunks[tcIdx].text).toBe('eof thinking')
  })

  it('EOF without finish and without visible reasoning emits completion but no thinking shell', async () => {
    const chunks = await drainThroughReadFullStream([{ type: 'reasoning-start', id: 'r-eof-empty' }])
    const types = chunks.map((c) => c.type)
    expect(types).not.toContain(ChunkType.THINKING_START)
    expect(types).not.toContain(ChunkType.THINKING_DELTA)
    expect(types).not.toContain(ChunkType.THINKING_COMPLETE)
    expect(chunks.filter((c) => c.type === ChunkType.BLOCK_COMPLETE)).toHaveLength(1)
    expect(chunks.filter((c) => c.type === ChunkType.LLM_RESPONSE_COMPLETE)).toHaveLength(1)
  })

  it('EOF after explicit finish does not double completion', async () => {
    const chunks = await drainThroughReadFullStream([
      { type: 'reasoning-start', id: 'r-eof-dup' },
      { type: 'reasoning-delta', text: 'once' },
      { type: 'finish', totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    ])
    expect(chunks.filter((c) => c.type === ChunkType.THINKING_COMPLETE)).toHaveLength(1)
    expect(chunks.filter((c) => c.type === ChunkType.BLOCK_COMPLETE)).toHaveLength(1)
    expect(chunks.filter((c) => c.type === ChunkType.LLM_RESPONSE_COMPLETE)).toHaveLength(1)
  })

  it('error chunk marks terminal: EOF must not emit SUCCESS completion', async () => {
    const chunks = await drainThroughReadFullStream([
      { type: 'reasoning-start', id: 'r-err' },
      { type: 'reasoning-delta', text: 'partial' },
      { type: 'error', error: new Error('boom') }
    ])
    const types = chunks.map((c) => c.type)
    // Visible thinking started, but terminal is ERROR not SUCCESS
    expect(types).toContain(ChunkType.THINKING_START)
    expect(types).toContain(ChunkType.ERROR)
    expect(types).not.toContain(ChunkType.BLOCK_COMPLETE)
    expect(types).not.toContain(ChunkType.LLM_RESPONSE_COMPLETE)
    expect(types).not.toContain(ChunkType.THINKING_COMPLETE)
  })

  it('abort chunk marks terminal: EOF must not emit SUCCESS completion', async () => {
    const chunks = await drainThroughReadFullStream([{ type: 'reasoning-start', id: 'r-abort' }, { type: 'abort' }])
    const types = chunks.map((c) => c.type)
    expect(types).toContain(ChunkType.ERROR)
    expect(types).not.toContain(ChunkType.BLOCK_COMPLETE)
    expect(types).not.toContain(ChunkType.LLM_RESPONSE_COMPLETE)
    // Empty pending reasoning never completes even on abort
    expect(types).not.toContain(ChunkType.THINKING_COMPLETE)
  })
})
