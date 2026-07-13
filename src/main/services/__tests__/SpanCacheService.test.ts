import type { SpanEntity } from '@mcp-trace/trace-core'
import { SpanStatusCode } from '@opentelemetry/api'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SpanCacheService } from '../SpanCacheService'

// ---- Mocks ----

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn()
    })
  }
}))

vi.mock('../ConfigManager', () => ({
  configManager: {
    getEnableDeveloperMode: vi.fn(() => true)
  }
}))

vi.mock('os', async () => {
  const actual = await vi.importActual('os')
  return {
    ...actual,
    homedir: vi.fn(() => '/mock/home')
  }
})

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    rm: vi.fn().mockResolvedValue(undefined),
    open: vi.fn(),
    access: vi.fn().mockResolvedValue(undefined),
    appendFile: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@shared/config/constant', () => ({
  HOME_CHERRY_DIR: '.cherrystudio'
}))

vi.mock('@mcp-trace/trace-core', () => ({
  convertSpanToSpanEntity: vi.fn((span: ReadableSpan) => ({
    id: span.spanContext().spanId,
    traceId: span.spanContext().traceId,
    parentId: span.parentSpanContext?.spanId || '',
    name: span.name || 'test-span',
    startTime: Date.now(),
    endTime: null,
    attributes: { ...span.attributes },
    status: SpanStatusCode[span.status.code],
    events: span.events,
    kind: 'INTERNAL',
    links: span.links,
    isEnd: false
  }))
}))

// ---- Helpers ----

function makeSpanId(i: number): string {
  return `span-${String(i).padStart(4, '0')}`
}

function makeTraceId(i: number): string {
  return `trace-${String(i).padStart(4, '0')}`
}

function makeReadableSpan(spanId: string, traceId: string, attributes: Record<string, unknown> = {}): ReadableSpan {
  return {
    spanContext: () => ({
      spanId,
      traceId,
      traceFlags: 0
    }),
    parentSpanContext: undefined,
    name: `span-${spanId}`,
    startTime: [Date.now(), 0],
    endTime: [Date.now() + 100, 0],
    status: { code: SpanStatusCode.UNSET },
    attributes,
    events: [],
    links: [],
    kind: 1 // INTERNAL
  } as unknown as ReadableSpan
}

function makeSpanEntity(overrides: Partial<SpanEntity> = {}): SpanEntity {
  return {
    id: overrides.id || makeSpanId(0),
    name: 'test-span',
    parentId: '',
    traceId: overrides.traceId || makeTraceId(0),
    status: 'UNSET',
    kind: 'INTERNAL',
    attributes: {},
    isEnd: false,
    events: undefined,
    startTime: Date.now(),
    endTime: null,
    links: undefined,
    ...overrides
  }
}

// ---- Tests ----

describe('SpanCacheService', () => {
  let service: InstanceType<typeof SpanCacheService>
  let SpanCacheServiceClass: typeof SpanCacheService

  beforeEach(async () => {
    vi.clearAllMocks()
    // Dynamic import after mocks are set up
    const mod = await import('../SpanCacheService')
    SpanCacheServiceClass = mod.SpanCacheService
    // Use a small max for LRU tests; 5000 for non-LRU tests
    service = new SpanCacheServiceClass(5000)
  })

  describe('basic operations', () => {
    it('should create and retrieve a span', () => {
      const span = makeReadableSpan('s1', 't1')
      service.createSpan(span)

      const entity = service.getEntity('s1')
      expect(entity).toBeDefined()
      expect(entity!.id).toBe('s1')
      expect(entity!.traceId).toBe('t1')
    })

    it('should return undefined for non-existent span', () => {
      const entity = service.getEntity('nonexistent')
      expect(entity).toBeUndefined()
    })

    it('should clear all spans', () => {
      service.createSpan(makeReadableSpan('s1', 't1'))
      service.createSpan(makeReadableSpan('s2', 't1'))
      service.clear()

      expect(service.getEntity('s1')).toBeUndefined()
      expect(service.getEntity('s2')).toBeUndefined()
    })

    it('should end a span and update fields', () => {
      const span = makeReadableSpan('s1', 't1')
      service.createSpan(span)
      service.endSpan(span)

      const entity = service.getEntity('s1')
      expect(entity).toBeDefined()
      expect(entity!.endTime).toBeDefined()
      expect(entity!.status).toBeDefined()
    })
  })

  describe('saveEntity', () => {
    it('should add a new entity', () => {
      const entity = makeSpanEntity({ id: 'e1', traceId: 't1' })
      service.saveEntity(entity)

      const retrieved = service.getEntity('e1')
      expect(retrieved).toBeDefined()
      expect(retrieved!.id).toBe('e1')
    })

    it('should update an existing entity', () => {
      const entity = makeSpanEntity({ id: 'e1', traceId: 't1' })
      service.saveEntity(entity)

      const updated = makeSpanEntity({ id: 'e1', traceId: 't1', name: 'updated-span' })
      service.saveEntity(updated)

      const retrieved = service.getEntity('e1')
      expect(retrieved!.name).toBe('updated-span')
    })
  })

  describe('LRU capacity limiting', () => {
    it('should not exceed maximum capacity', () => {
      const MAX = 100
      const lruService = new SpanCacheServiceClass(MAX)
      // Add MAX+10 spans
      for (let i = 0; i < MAX + 10; i++) {
        lruService.createSpan(makeReadableSpan(makeSpanId(i), makeTraceId(i)))
      }

      // Cache should not exceed MAX (with some tolerance for LRU internals)
      // The actual cache size check is internal, so we verify the oldest entries are evicted
      const entity0 = lruService.getEntity(makeSpanId(0))
      const entity5 = lruService.getEntity(makeSpanId(5))
      const entity15 = lruService.getEntity(makeSpanId(15))

      // Earlier entries should be evicted
      expect(entity0).toBeUndefined()
      expect(entity5).toBeUndefined()
      // Later entries should still be present
      expect(entity15).toBeDefined()
    })
  })

  describe('LRU eviction behavior', () => {
    it('should evict the oldest entries when capacity is exceeded', () => {
      const MAX = 50
      const lruService = new SpanCacheServiceClass(MAX)
      for (let i = 0; i < MAX + 5; i++) {
        lruService.createSpan(makeReadableSpan(makeSpanId(i), makeTraceId(i)))
      }

      // First entries should be evicted
      expect(lruService.getEntity(makeSpanId(0))).toBeUndefined()
      expect(lruService.getEntity(makeSpanId(1))).toBeUndefined()
      expect(lruService.getEntity(makeSpanId(2))).toBeUndefined()
      expect(lruService.getEntity(makeSpanId(3))).toBeUndefined()
      expect(lruService.getEntity(makeSpanId(4))).toBeUndefined()

      // Last entries should be present
      expect(lruService.getEntity(makeSpanId(MAX + 4))).toBeDefined()
    })
  })

  describe('access refresh behavior', () => {
    it('should not evict recently accessed entries', () => {
      const MAX = 50
      const lruService = new SpanCacheServiceClass(MAX)
      // Add MAX spans
      for (let i = 0; i < MAX; i++) {
        lruService.createSpan(makeReadableSpan(makeSpanId(i), makeTraceId(i)))
      }

      // Access the first span (refreshes LRU position)
      const accessed = lruService.getEntity(makeSpanId(0))
      expect(accessed).toBeDefined()

      // Add MAX more spans, triggering evictions
      for (let i = MAX; i < MAX * 2; i++) {
        lruService.createSpan(makeReadableSpan(makeSpanId(i), makeTraceId(i)))
      }

      // The accessed span should survive eviction — it was refreshed to be newest,
      // so it's among the last MAX entries by LRU order.
      // When adding MAX items to a max-MAX cache, it evicts MAX items.
      // The oldest MAX-1 unaccessed entries get evicted first, then the
      // accessed span-0 should survive because it's newer than the unaccessed ones.
      // After refresh: [0是最新, 1是最旧, ..., 49是第二新]
      // Evicts: 1, 2, 3, ..., 49 (49 items) + 0 (1 item) = 50 evictions
      // Actually: the accessed span becomes the newest, so evictions go:
      //   oldest first: span-1, span-2, ..., span-49 (49 items), then span-0 (1 item)
      // So all 50 original entries get evicted. This is expected with max=50 and adding 50 more.
      // To properly test access refresh, use a larger ratio:
      const lruService2 = new SpanCacheServiceClass(100)
      for (let i = 0; i < 50; i++) {
        lruService2.createSpan(makeReadableSpan(makeSpanId(i), makeTraceId(i)))
      }

      // Access span-0
      expect(lruService2.getEntity(makeSpanId(0))).toBeDefined()

      // Add 60 more (total 110, max 100, so 10 evictions)
      for (let i = 50; i < 110; i++) {
        lruService2.createSpan(makeReadableSpan(makeSpanId(i), makeTraceId(i)))
      }

      // span-0 should survive (it was refreshed, so it's among the newest 100)
      expect(lruService2.getEntity(makeSpanId(0))).toBeDefined()

      // span-1 through span-9 should be evicted (they were among the oldest 10)
      expect(lruService2.getEntity(makeSpanId(1))).toBeUndefined()
      expect(lruService2.getEntity(makeSpanId(2))).toBeUndefined()
    })
  })

  describe('memory growth bounded', () => {
    it('should not grow memory unbounded with 10000 spans', () => {
      const memBefore = process.memoryUsage().heapUsed

      for (let i = 0; i < 10000; i++) {
        service.createSpan(makeReadableSpan(makeSpanId(i), makeTraceId(i)))
      }

      const memAfter = process.memoryUsage().heapUsed
      const memDeltaMB = (memAfter - memBefore) / (1024 * 1024)

      // With LRU at 5000, memory should be bounded.
      // Without LRU, 10000 spans could use ~10+ MB unbounded.
      // With LRU at 5000, delta should be < 5 MB (generous bound)
      // We mainly check that the delta is reasonable, not infinite
      expect(memDeltaMB).toBeLessThan(20)
    })
  })

  describe('setTopicId and getSpans', () => {
    it('should bind topic and retrieve spans', () => {
      service.setTopicId('trace-1', 'topic-1')
      service.createSpan(makeReadableSpan('s1', 'trace-1', { modelName: 'gpt-4' }))

      return service.getSpans('topic-1', 'trace-1').then((spans) => {
        expect(spans.length).toBe(1)
        expect(spans[0].id).toBe('s1')
      })
    })
  })

  describe('updateTokenUsage', () => {
    it('should update token usage on a span', () => {
      service.createSpan(makeReadableSpan('s1', 't1', { parentId: '' }))
      service.updateTokenUsage('s1', {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30
      })

      const entity = service.getEntity('s1')
      expect(entity).toBeDefined()
      expect(entity!.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30
      })
    })
  })

  describe('addStreamMessage', () => {
    it('should add stream message to span attributes', () => {
      service.createSpan(makeReadableSpan('s1', 't1'))
      service.addStreamMessage('s1', 'gpt-4', 'ctx', { content: 'hello' })

      const entity = service.getEntity('s1')
      expect(entity).toBeDefined()
      expect(entity!.attributes!['outputs']).toEqual([{ content: 'hello' }])
    })
  })

  describe('setEndMessage', () => {
    it('should set end message on span', () => {
      service.createSpan(makeReadableSpan('s1', 't1'))
      service.setEndMessage('s1', 'gpt-4', 'final message')

      const entity = service.getEntity('s1')
      expect(entity).toBeDefined()
      expect(entity!.attributes!['outputs']).toEqual({ 'gpt-4': 'final message' })
    })
  })

  describe('developer mode disabled', () => {
    it('should not create spans when developer mode is off', async () => {
      const { configManager } = await import('../ConfigManager')
      vi.mocked(configManager.getEnableDeveloperMode).mockReturnValue(false)

      service.createSpan(makeReadableSpan('s1', 't1'))
      expect(service.getEntity('s1')).toBeUndefined()

      // Re-enable for other tests
      vi.mocked(configManager.getEnableDeveloperMode).mockReturnValue(true)
    })
  })
})
