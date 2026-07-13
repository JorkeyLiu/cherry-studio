/**
 * useSettings Selector 计算性能基准测试
 *
 * 对比 selectWholeSettings (返回整个 settings 对象) vs 细粒度 selector (返回单个字段)
 * 在不同数量级下的性能差异。
 *
 * 使用 vitest bench() API，通过 pnpm bench:renderer 运行。
 */
import type { SettingsState } from '@renderer/store/settings'
import { initialState } from '@renderer/store/settings'
import { bench, describe, expect, test } from 'vitest'

// ============================================================================
// 1. 构造测试数据 — 扩展 settings 到不同规模
// ============================================================================

/**
 * 创建一个包含 N 个额外字段的 settings 对象，
 * 用于模拟 settings 随业务增长膨胀的场景。
 */
function createExtendedSettings(extraFieldCount: number): SettingsState {
  const extended = { ...initialState }
  for (let i = 0; i < extraFieldCount; i++) {
    ;(extended as any)[`extra_field_${i}`] = `value_${i}`
  }
  return extended
}

// 不同规模的 settings 对象
const SCENARIOS = {
  baseline: initialState, // 原始 initialState (~100 fields)
  medium: createExtendedSettings(50), // +50 fields
  large: createExtendedSettings(200) // +200 fields
} as const

// ============================================================================
// 2. Selector 实现
// ============================================================================

// 当前实现：返回整个 settings 对象
const selectWholeSettings = (state: { settings: SettingsState }) => state.settings

// 细粒度 selector：返回单个字段
const selectTheme = (state: { settings: SettingsState }) => state.settings.theme
const selectFontSize = (state: { settings: SettingsState }) => state.settings.fontSize
const selectUserName = (state: { settings: SettingsState }) => state.settings.userName
const selectLanguage = (state: { settings: SettingsState }) => state.settings.language
const selectMessageStyle = (state: { settings: SettingsState }) => state.settings.messageStyle
const selectTopicPosition = (state: { settings: SettingsState }) => state.settings.topicPosition

// 模拟一个使用多个字段的组件 selector
const selectMultipleFields = (state: { settings: SettingsState }) => ({
  theme: state.settings.theme,
  fontSize: state.settings.fontSize,
  messageStyle: state.settings.messageStyle,
  topicPosition: state.settings.topicPosition
})

// 模拟 shallowEqual 比较（React-Redux 默认使用 Object.is）
function shallowEqual(a: any, b: any): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !Object.is(a[key], b[key])) return false
  }
  return true
}

// ============================================================================
// 3. 正确性验证
// ============================================================================

test('selectors return correct values', () => {
  const state = { settings: SCENARIOS.baseline }

  expect(selectWholeSettings(state)).toBe(state.settings)
  expect(selectTheme(state)).toBe('system')
  expect(selectFontSize(state)).toBe(14)
  expect(selectUserName(state)).toBe('')
  expect(selectLanguage(state)).toBe(state.settings.language)
  expect(selectMessageStyle(state)).toBe('plain')
  expect(selectTopicPosition(state)).toBe('left')

  const multiFields = selectMultipleFields(state)
  expect(multiFields).toEqual({
    theme: 'system',
    fontSize: 14,
    messageStyle: 'plain',
    topicPosition: 'left'
  })
})

test('shallowEqual correctly compares', () => {
  const obj = { a: 1, b: 2 }
  expect(shallowEqual(obj, obj)).toBe(true)
  expect(shallowEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true)
  expect(shallowEqual({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false)
  expect(shallowEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false)
})

// ============================================================================
// 4. 基准测试
// ============================================================================

const benchOptions = (overrides = {}) => ({
  iterations: 10000,
  warmupIterations: 1000,
  ...overrides
})

describe('Settings Selector Performance', () => {
  Object.entries(SCENARIOS).forEach(([scenarioName, settings]) => {
    describe(`${scenarioName} settings (${Object.keys(settings).length} fields)`, () => {
      const state = { settings }

      bench(
        'selectWholeSettings (returns entire object)',
        () => {
          selectWholeSettings(state)
        },
        benchOptions()
      )

      bench(
        'selectTheme (single field)',
        () => {
          selectTheme(state)
        },
        benchOptions()
      )

      bench(
        'selectFontSize (single field)',
        () => {
          selectFontSize(state)
        },
        benchOptions()
      )

      bench(
        'selectMultipleFields (4 fields, creates new object)',
        () => {
          selectMultipleFields(state)
        },
        benchOptions()
      )
    })
  })
})

describe('Selector Comparison (baseline settings)', () => {
  const state = { settings: SCENARIOS.baseline }

  bench(
    'selectWholeSettings + Object.is comparison',
    () => {
      const prev = selectWholeSettings(state)
      const next = selectWholeSettings(state)
      Object.is(prev, next) // same reference, always true
    },
    benchOptions()
  )

  bench(
    'selectWholeSettings + shallowEqual comparison',
    () => {
      const prev = selectWholeSettings(state)
      const next = selectWholeSettings(state)
      shallowEqual(prev, next) // always true, but O(n) check
    },
    benchOptions()
  )

  bench(
    'selectTheme + Object.is comparison',
    () => {
      const prev = selectTheme(state)
      const next = selectTheme(state)
      Object.is(prev, next)
    },
    benchOptions()
  )

  bench(
    'selectMultipleFields + shallowEqual comparison',
    () => {
      const prev = selectMultipleFields(state)
      const next = selectMultipleFields(state)
      shallowEqual(prev, next)
    },
    benchOptions()
  )
})
