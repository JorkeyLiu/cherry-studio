/**
 * useAssistant Selector 性能基准测试
 *
 * 对比 .find() selector 在不同 assistant 数量下的性能
 * vs memoized selector (createSelector) 在相同条件下的性能。
 *
 * 使用 vitest bench() API，通过 pnpm bench:renderer 运行。
 */
import { createSelector } from '@reduxjs/toolkit'
import type { Assistant } from '@renderer/types'
import { bench, describe, expect, test } from 'vitest'

// ============================================================================
// 1. 构造测试数据
// ============================================================================

const MOCK_MODEL = {
  id: 'gpt-4o',
  name: 'GPT-4o',
  provider: 'openai'
} as Assistant['model']

function createAssistant(index: number): Assistant {
  return {
    id: `assistant-${index}`,
    name: `Assistant ${index}`,
    emoji: '🤖',
    prompt: `System prompt for assistant ${index}`,
    topics: [
      {
        id: `topic-${index}`,
        assistantId: `assistant-${index}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        name: 'New Session',
        messages: []
      }
    ],
    type: 'assistant',
    model: MOCK_MODEL,
    regularPhrases: []
  }
}

function createAssistants(count: number): Assistant[] {
  return Array.from({ length: count }, (_, i) => createAssistant(i))
}

// 不同规模的 assistants 数组
const SCENARIOS = [10, 50, 100] as const

// ============================================================================
// 2. Selector 实现
// ============================================================================

interface AssistantsState {
  assistants: Assistant[]
}

// 当前实现：使用 .find() — 每次调用都遍历数组
const selectAssistantFind = (state: AssistantsState, targetId: string) =>
  state.assistants.find((a) => a.id === targetId)

// Memoized selector：使用 createSelector 缓存结果
// 当 assistants 数组不变时，返回缓存的引用
const createSelectAssistantMemoized = (targetId: string) =>
  createSelector([(state: AssistantsState) => state.assistants], (assistants) =>
    assistants.find((a) => a.id === targetId)
  )

// Memoized selector for multiple IDs — 模拟批量查找
const createSelectAssistantBatch = (ids: string[]) =>
  createSelector([(state: AssistantsState) => state.assistants], (assistants) =>
    ids.map((id) => assistants.find((a) => a.id === id)).filter(Boolean)
  )

// ============================================================================
// 3. 正确性验证
// ============================================================================

test('.find() selector returns correct assistant', () => {
  const assistants = createAssistants(10)
  const state = { assistants }

  const result = selectAssistantFind(state, 'assistant-3')
  expect(result).toBeDefined()
  expect(result!.id).toBe('assistant-3')
  expect(result!.name).toBe('Assistant 3')
})

test('memoized selector returns correct assistant', () => {
  const selector = createSelectAssistantMemoized('assistant-3')
  const state = { assistants: createAssistants(10) }

  const result = selector(state)
  expect(result).toBeDefined()
  expect(result!.id).toBe('assistant-3')
})

test('memoized selector caches result when state unchanged', () => {
  const selector = createSelectAssistantMemoized('assistant-5')
  const assistants = createAssistants(10)
  const state1 = { assistants }
  const state2 = { assistants } // same array reference

  const result1 = selector(state1)
  const result2 = selector(state2)
  expect(result1).toBe(result2) // same reference
})

// ============================================================================
// 4. 基准测试
// ============================================================================

const benchOptions = (overrides = {}) => ({
  iterations: 10000,
  warmupIterations: 1000,
  ...overrides
})

describe('Assistant .find() Selector Performance', () => {
  SCENARIOS.forEach((count) => {
    describe(`${count} assistants`, () => {
      const assistants = createAssistants(count)
      const state = { assistants }
      const targetId = `assistant-${Math.floor(count / 2)}` // middle element

      bench(
        `.find() — search for ${targetId}`,
        () => {
          selectAssistantFind(state, targetId)
        },
        benchOptions()
      )

      bench(
        `.find() — search for last element`,
        () => {
          selectAssistantFind(state, `assistant-${count - 1}`)
        },
        benchOptions()
      )
    })
  })
})

describe('Memoized Selector Performance', () => {
  SCENARIOS.forEach((count) => {
    describe(`${count} assistants`, () => {
      const assistants = createAssistants(count)
      const state = { assistants }
      const targetId = `assistant-${Math.floor(count / 2)}`
      const selector = createSelectAssistantMemoized(targetId)

      // Warm up the memoized selector
      selector(state)

      bench(
        `memoized selector — same state (cache hit)`,
        () => {
          selector(state)
        },
        benchOptions()
      )

      // Create a new state with a different assistant modified
      const modifiedAssistants = assistants.map((a, i) => (i === count - 1 ? { ...a, name: 'Modified' } : a))
      const modifiedState = { assistants: modifiedAssistants }

      bench(
        `memoized selector — modified state (cache miss)`,
        () => {
          selector(modifiedState)
        },
        benchOptions()
      )
    })
  })
})

describe('.find() vs Memoized Comparison', () => {
  SCENARIOS.forEach((count) => {
    describe(`${count} assistants`, () => {
      const assistants = createAssistants(count)
      const state = { assistants }
      const targetId = `assistant-${Math.floor(count / 2)}`
      const memoizedSelector = createSelectAssistantMemoized(targetId)

      // Warm up
      memoizedSelector(state)

      bench(
        `.find() — repeated calls on same state`,
        () => {
          // Simulates a component re-rendering with same state
          selectAssistantFind(state, targetId)
          selectAssistantFind(state, targetId)
          selectAssistantFind(state, targetId)
        },
        benchOptions()
      )

      bench(
        `memoized — repeated calls on same state`,
        () => {
          // Simulates a component re-rendering with same state
          memoizedSelector(state)
          memoizedSelector(state)
          memoizedSelector(state)
        },
        benchOptions()
      )

      // Simulate state changes: modify one unrelated assistant
      bench(
        `.find() — after unrelated assistant modification`,
        () => {
          // Create new state (as Redux would after dispatch)
          const newState = {
            assistants: assistants.map((a, i) => (i === 0 ? { ...a, name: 'Updated' } : a))
          }
          selectAssistantFind(newState, targetId)
        },
        benchOptions()
      )

      bench(
        `memoized — after unrelated assistant modification`,
        () => {
          const newState = {
            assistants: assistants.map((a, i) => (i === 0 ? { ...a, name: 'Updated' } : a))
          }
          memoizedSelector(newState)
        },
        benchOptions()
      )
    })
  })
})

describe('Batch Lookup Performance', () => {
  SCENARIOS.forEach((count) => {
    describe(`${count} assistants`, () => {
      const assistants = createAssistants(count)
      const state = { assistants }

      // Look up 5 random assistants
      const lookupIds = Array.from({ length: 5 }, (_, i) => `assistant-${i * Math.floor(count / 5)}`)
      const batchSelector = createSelectAssistantBatch(lookupIds)
      batchSelector(state) // warm up

      bench(
        `.find() × 5 — batch lookup`,
        () => {
          lookupIds.forEach((id) => selectAssistantFind(state, id))
        },
        benchOptions()
      )

      bench(
        `memoized batch — single selector`,
        () => {
          batchSelector(state)
        },
        benchOptions()
      )
    })
  })
})
