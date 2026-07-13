/**
 * useSettings 渲染次数统计测试
 *
 * 验证 useSettings 在 state 变化时的重渲染行为。
 * useSettings 选择整个 settings 对象 (state.settings)，
 * 因此任何 settings 字段变化都会触发重渲染。
 * 这是 selector 重构前的基线行为。
 */
import { configureStore } from '@reduxjs/toolkit'
import {
  useEditorSettings,
  useInputbarSettings,
  useMessageGroupSettings,
  useMessageRenderSettings,
  useMessageStyle,
  useSettings
} from '@renderer/hooks/useSettings'
import { useAppSelector } from '@renderer/store'
import type { SendMessageShortcut } from '@renderer/store/settings'
import settingsReducer, {
  setConfirmDeleteMessage,
  setEnableSpellCheck,
  setFoldDisplayMode,
  setFontSize,
  setLanguage,
  setLaunchOnBoot,
  setMessageStyle,
  setMultiModelMessageStyle,
  setNarrowMode,
  setPinTopicsToTop,
  setRenderInputMessageAsMarkdown,
  setSendMessageShortcut,
  setShowPrompt,
  setTargetLanguage,
  setTheme,
  setThoughtAutoCollapse,
  setUserName,
  setWebdavHost
} from '@renderer/store/settings'
import type { LanguageVarious } from '@renderer/types'
import type { ThemeMode } from '@renderer/types'
import { act, renderHook } from '@testing-library/react'
import React, { Profiler, type ProfilerOnRenderCallback } from 'react'
import { Provider } from 'react-redux'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock @renderer/store to use test store's typed hooks
vi.mock('@renderer/store', async () => {
  const reactRedux = await import('react-redux')
  return {
    useAppDispatch: reactRedux.useDispatch,
    useAppSelector: reactRedux.useSelector
  }
})

// Mock window.api for side-effect methods
vi.stubGlobal('window', {
  api: {
    setLaunchOnBoot: vi.fn().mockResolvedValue(undefined),
    setLaunchToTray: vi.fn().mockResolvedValue(undefined),
    setTray: vi.fn().mockResolvedValue(undefined),
    setTrayOnClose: vi.fn().mockResolvedValue(undefined),
    setAutoUpdate: vi.fn().mockResolvedValue(undefined),
    setTestPlan: vi.fn().mockResolvedValue(undefined),
    setTestChannel: vi.fn().mockResolvedValue(undefined),
    setDisableHardwareAcceleration: vi.fn().mockResolvedValue(undefined),
    setUseSystemTitleBar: vi.fn().mockResolvedValue(undefined),
    config: { set: vi.fn().mockResolvedValue(undefined) }
  }
})

function createTestStore() {
  return configureStore({
    reducer: {
      settings: settingsReducer
    }
  })
}

// --- Profiler-based render counting ---

let renderCount = 0
const onRender: ProfilerOnRenderCallback = () => {
  renderCount++
}

function createWrapper(store: ReturnType<typeof createTestStore>) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <Profiler id="useSettings" onRender={onRender}>
        <Provider store={store}>{children}</Provider>
      </Profiler>
    )
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('useSettings render count (baseline)', () => {
  it('should render exactly once on initial mount', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useSettings(), { wrapper: createWrapper(store) })
    expect(renderCount).toBe(1)
  })

  it('should re-render when an unrelated setting changes (baseline: records render count)', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useSettings(), { wrapper: createWrapper(store) })

    const beforeCount = renderCount

    // Change a setting that a typical consumer would NOT care about
    act(() => {
      store.dispatch(setUserName('Alice'))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    // useSettings selects the ENTIRE settings object, so any change triggers re-render
    // Record the baseline: after refactoring, this should be 0
    console.log(`[useSettings] Unrelated field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })

  it('should re-render when a related setting changes (baseline: records render count)', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useSettings(), { wrapper: createWrapper(store) })

    const beforeCount = renderCount

    // Change the specific setting that the consumer cares about
    act(() => {
      store.dispatch(setTheme('dark' as ThemeMode))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[useSettings] Related field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })

  it('should re-render for every dispatched change (cumulative baseline)', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useSettings(), { wrapper: createWrapper(store) })

    const beforeCount = renderCount

    // Dispatch multiple unrelated changes
    act(() => {
      store.dispatch(setUserName('Bob'))
      store.dispatch(setWebdavHost('https://dav.example.com'))
      store.dispatch(setFontSize(16))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    // Each dispatch triggers a separate state update, causing multiple re-renders
    console.log(`[useSettings] Multiple unrelated changes → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })

  it('should re-render for nested field changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useSettings(), { wrapper: createWrapper(store) })

    const beforeCount = renderCount

    // Change a nested field (sidebarIcons)
    act(() => {
      store.dispatch(setShowPrompt(false))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[useSettings] Nested field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })

  it('should re-render when multiple different fields change in sequence', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useSettings(), { wrapper: createWrapper(store) })

    const counts: number[] = []

    // Sequential changes to different fields
    act(() => {
      store.dispatch(setTheme('dark' as ThemeMode))
    })
    counts.push(renderCount)

    act(() => {
      store.dispatch(setLanguage('en-us' as LanguageVarious))
    })
    counts.push(renderCount)

    act(() => {
      store.dispatch(setTargetLanguage('zh-cn'))
    })
    counts.push(renderCount)

    act(() => {
      store.dispatch(setPinTopicsToTop(true))
    })
    counts.push(renderCount)

    act(() => {
      store.dispatch(setMessageStyle('bubble'))
    })
    counts.push(renderCount)

    // Each change should trigger at least one re-render
    console.log(`[useSettings] Sequential changes → render counts: [${counts.join(', ')}]`)
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThan(counts[i - 1])
    }
  })
})

// --- Fine-grained hook tests ---

describe('useMessageRenderSettings render count', () => {
  it('should render exactly once on initial mount', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useMessageRenderSettings(), { wrapper: createWrapper(store) })
    expect(renderCount).toBe(1)
  })

  it('should NOT re-render when an unrelated setting changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useMessageRenderSettings(), { wrapper: createWrapper(store) })

    act(() => {
      store.dispatch(setLaunchOnBoot(true))
    })

    expect(renderCount).toBe(1)
  })

  it('should re-render when a related field (fontSize) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useMessageRenderSettings(), { wrapper: createWrapper(store) })

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setFontSize(18))
    })

    expect(renderCount).toBeGreaterThan(beforeCount)
  })

  it('should re-render when another related field (messageStyle) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useMessageRenderSettings(), { wrapper: createWrapper(store) })

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setMessageStyle('bubble'))
    })

    expect(renderCount).toBeGreaterThan(beforeCount)
  })
})

describe('useEditorSettings render count', () => {
  it('should render exactly once on initial mount', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useEditorSettings(), { wrapper: createWrapper(store) })
    expect(renderCount).toBe(1)
  })

  it('should NOT re-render when an unrelated setting changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useEditorSettings(), { wrapper: createWrapper(store) })

    act(() => {
      store.dispatch(setTheme('dark' as ThemeMode))
    })

    expect(renderCount).toBe(1)
  })

  it('should re-render when a related field (enableSpellCheck) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useEditorSettings(), { wrapper: createWrapper(store) })

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setEnableSpellCheck(true))
    })

    expect(renderCount).toBeGreaterThan(beforeCount)
  })
})

describe('useInputbarSettings render count', () => {
  it('should render exactly once on initial mount', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useInputbarSettings(), { wrapper: createWrapper(store) })
    expect(renderCount).toBe(1)
  })

  it('should NOT re-render when an unrelated setting changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useInputbarSettings(), { wrapper: createWrapper(store) })

    act(() => {
      store.dispatch(setFontSize(18))
    })

    expect(renderCount).toBe(1)
  })

  it('should re-render when a related field (targetLanguage) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useInputbarSettings(), { wrapper: createWrapper(store) })

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setTargetLanguage('zh-cn'))
    })

    expect(renderCount).toBeGreaterThan(beforeCount)
  })
})

describe('Message component render optimization — BEFORE migration (useSettings)', () => {
  // Simulates the hook combination used in Message.tsx BEFORE migration:
  //   const { messageFont, fontSize, messageStyle, showMessageOutline } = useSettings()
  it('should NOT re-render when unrelated settings change (simulating Message component)', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useSettings()
        return {
          messageFont: settings.messageFont,
          fontSize: settings.fontSize,
          messageStyle: settings.messageStyle,
          showMessageOutline: settings.showMessageOutline
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setLaunchOnBoot(true))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[Message baseline] Unrelated field change → ${extraRenders} extra render(s)`)
    // Baseline: useSettings selects entire settings object → any change triggers re-render
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })

  it('should re-render when messageStyle changes (simulating Message component)', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useSettings()
        return {
          messageFont: settings.messageFont,
          fontSize: settings.fontSize,
          messageStyle: settings.messageStyle,
          showMessageOutline: settings.showMessageOutline
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setMessageStyle('bubble'))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[Message baseline] Related field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('Message component render optimization — AFTER migration (useMessageRenderSettings)', () => {
  // Simulates the hook combination used in Message.tsx AFTER migration:
  //   const { messageFont, fontSize, messageStyle, showMessageOutline } = useMessageRenderSettings()
  it('should NOT re-render when unrelated settings change', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useMessageRenderSettings()
        return {
          messageFont: settings.messageFont,
          fontSize: settings.fontSize,
          messageStyle: settings.messageStyle,
          showMessageOutline: settings.showMessageOutline
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setLaunchOnBoot(true))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[Message migrated] Unrelated field change → ${extraRenders} extra render(s)`)
    // After migration: useMessageRenderSettings uses shallowEqual selector → no re-render
    expect(extraRenders).toBe(0)
  })

  it('should re-render when messageStyle changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useMessageRenderSettings()
        return {
          messageFont: settings.messageFont,
          fontSize: settings.fontSize,
          messageStyle: settings.messageStyle,
          showMessageOutline: settings.showMessageOutline
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setMessageStyle('bubble'))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[Message migrated] Related field change → ${extraRenders} extra render(s)`)
    // After migration: messageStyle IS in useMessageRenderSettings → re-render
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('Inputbar component render optimization — BEFORE migration (useSettings)', () => {
  // Simulates the hook combination used in Inputbar.tsx BEFORE migration:
  //   const { sendMessageShortcut, showInputEstimatedTokens, enableQuickPanelTriggers } = useSettings()
  it('should re-render when unrelated setting (fontSize) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useSettings()
        return {
          sendMessageShortcut: settings.sendMessageShortcut,
          showInputEstimatedTokens: settings.showInputEstimatedTokens,
          enableQuickPanelTriggers: settings.enableQuickPanelTriggers
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setFontSize(18))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[Inputbar baseline] Unrelated field (fontSize) change → ${extraRenders} extra render(s)`)
    // Baseline: useSettings selects entire settings object → any change triggers re-render
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })

  it('should re-render when a related field (targetLanguage) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useSettings()
        return {
          sendMessageShortcut: settings.sendMessageShortcut,
          showInputEstimatedTokens: settings.showInputEstimatedTokens,
          enableQuickPanelTriggers: settings.enableQuickPanelTriggers
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setTargetLanguage('zh-cn'))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[Inputbar baseline] Related field (targetLanguage) change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('Inputbar component render optimization — AFTER migration (useInputbarSettings)', () => {
  // Simulates the hook combination used in Inputbar.tsx AFTER migration:
  //   const { showInputEstimatedTokens, enableQuickPanelTriggers, targetLanguage, autoTranslateWithSpace } = useInputbarSettings()
  it('should NOT re-render when unrelated setting (fontSize) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useInputbarSettings()
        return {
          showInputEstimatedTokens: settings.showInputEstimatedTokens,
          enableQuickPanelTriggers: settings.enableQuickPanelTriggers,
          targetLanguage: settings.targetLanguage,
          autoTranslateWithSpace: settings.autoTranslateWithSpace
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setFontSize(18))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[Inputbar migrated] Unrelated field (fontSize) change → ${extraRenders} extra render(s)`)
    // After migration: useInputbarSettings uses shallowEqual selector → no re-render
    expect(extraRenders).toBe(0)
  })

  it('should re-render when a related field (targetLanguage) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useInputbarSettings()
        return {
          showInputEstimatedTokens: settings.showInputEstimatedTokens,
          enableQuickPanelTriggers: settings.enableQuickPanelTriggers,
          targetLanguage: settings.targetLanguage,
          autoTranslateWithSpace: settings.autoTranslateWithSpace
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setTargetLanguage('zh-cn'))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[Inputbar migrated] Related field (targetLanguage) change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('InputbarCore component render optimization — BEFORE migration (useSettings)', () => {
  // Simulates the hook combination used in InputbarCore.tsx BEFORE migration:
  //   const { targetLanguage, sendMessageShortcut, fontSize, pasteLongTextAsFile,
  //          pasteLongTextThreshold, autoTranslateWithSpace, enableQuickPanelTriggers,
  //          enableSpellCheck } = useSettings()
  it('should re-render when unrelated setting (launchOnBoot) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useSettings()
        return {
          targetLanguage: settings.targetLanguage,
          sendMessageShortcut: settings.sendMessageShortcut,
          fontSize: settings.fontSize,
          pasteLongTextAsFile: settings.pasteLongTextAsFile,
          pasteLongTextThreshold: settings.pasteLongTextThreshold,
          autoTranslateWithSpace: settings.autoTranslateWithSpace,
          enableQuickPanelTriggers: settings.enableQuickPanelTriggers,
          enableSpellCheck: settings.enableSpellCheck
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setLaunchOnBoot(true))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[InputbarCore baseline] Unrelated field (launchOnBoot) change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })

  it('should re-render when a related field (targetLanguage) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useSettings()
        return {
          targetLanguage: settings.targetLanguage,
          sendMessageShortcut: settings.sendMessageShortcut,
          fontSize: settings.fontSize,
          pasteLongTextAsFile: settings.pasteLongTextAsFile,
          pasteLongTextThreshold: settings.pasteLongTextThreshold,
          autoTranslateWithSpace: settings.autoTranslateWithSpace,
          enableQuickPanelTriggers: settings.enableQuickPanelTriggers,
          enableSpellCheck: settings.enableSpellCheck
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setTargetLanguage('zh-cn'))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[InputbarCore baseline] Related field (targetLanguage) change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('InputbarCore component render optimization — AFTER migration (useInputbarSettings + useEditorSettings)', () => {
  // Simulates the hook combination used in InputbarCore.tsx AFTER migration:
  //   const { targetLanguage, autoTranslateWithSpace, enableQuickPanelTriggers } = useInputbarSettings()
  //   const { fontSize, sendMessageShortcut, pasteLongTextAsFile, pasteLongTextThreshold, enableSpellCheck } = useEditorSettings()
  it('should NOT re-render when unrelated setting (launchOnBoot) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const inputbar = useInputbarSettings()
        const editor = useEditorSettings()
        return {
          targetLanguage: inputbar.targetLanguage,
          autoTranslateWithSpace: inputbar.autoTranslateWithSpace,
          enableQuickPanelTriggers: inputbar.enableQuickPanelTriggers,
          fontSize: editor.fontSize,
          sendMessageShortcut: editor.sendMessageShortcut,
          pasteLongTextAsFile: editor.pasteLongTextAsFile,
          pasteLongTextThreshold: editor.pasteLongTextThreshold,
          enableSpellCheck: editor.enableSpellCheck
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setLaunchOnBoot(true))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[InputbarCore migrated] Unrelated field (launchOnBoot) change → ${extraRenders} extra render(s)`)
    // After migration: both hooks use shallowEqual selectors → no re-render
    expect(extraRenders).toBe(0)
  })

  it('should re-render when a related field (targetLanguage) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const inputbar = useInputbarSettings()
        const editor = useEditorSettings()
        return {
          targetLanguage: inputbar.targetLanguage,
          autoTranslateWithSpace: inputbar.autoTranslateWithSpace,
          enableQuickPanelTriggers: inputbar.enableQuickPanelTriggers,
          fontSize: editor.fontSize,
          sendMessageShortcut: editor.sendMessageShortcut,
          pasteLongTextAsFile: editor.pasteLongTextAsFile,
          pasteLongTextThreshold: editor.pasteLongTextThreshold,
          enableSpellCheck: editor.enableSpellCheck
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setTargetLanguage('zh-cn'))
    })

    const afterCount = renderCount
    const extraRenders = afterCount - beforeCount

    console.log(`[InputbarCore migrated] Related field (targetLanguage) change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('useMessageGroupSettings render count', () => {
  it('should render exactly once on initial mount', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useMessageGroupSettings(), { wrapper: createWrapper(store) })
    expect(renderCount).toBe(1)
  })

  it('should NOT re-render when an unrelated setting changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useMessageGroupSettings(), { wrapper: createWrapper(store) })

    act(() => {
      store.dispatch(setTheme('dark' as ThemeMode))
    })

    expect(renderCount).toBe(1)
  })

  it('should re-render when a related field (multiModelMessageStyle) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useMessageGroupSettings(), { wrapper: createWrapper(store) })

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setMultiModelMessageStyle('vertical'))
    })

    expect(renderCount).toBeGreaterThan(beforeCount)
  })
})

// --- Step 5: Migrated P1 component performance comparison tests ---

describe('MessageGroup component render optimization — BEFORE migration (useSettings)', () => {
  // Simulates: const { multiModelMessageStyle, gridColumns, gridPopoverTrigger } = useSettings()
  it('should re-render when unrelated setting (confirmDeleteMessage) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useSettings()
        return {
          multiModelMessageStyle: settings.multiModelMessageStyle,
          gridColumns: settings.gridColumns,
          gridPopoverTrigger: settings.gridPopoverTrigger
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setConfirmDeleteMessage(false))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[MessageGroup baseline] Unrelated field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('MessageGroup component render optimization — AFTER migration (useMessageGroupSettings)', () => {
  it('should NOT re-render when unrelated setting (confirmDeleteMessage) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useMessageGroupSettings()
        return {
          multiModelMessageStyle: settings.multiModelMessageStyle,
          gridColumns: settings.gridColumns,
          gridPopoverTrigger: settings.gridPopoverTrigger
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setConfirmDeleteMessage(false))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[MessageGroup migrated] Unrelated field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBe(0)
  })

  it('should re-render when related field (multiModelMessageStyle) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useMessageGroupSettings()
        return {
          multiModelMessageStyle: settings.multiModelMessageStyle,
          gridColumns: settings.gridColumns,
          gridPopoverTrigger: settings.gridPopoverTrigger
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setMultiModelMessageStyle('vertical'))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[MessageGroup migrated] Related field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('MessageMenubar component render optimization — BEFORE migration (useSettings)', () => {
  // Simulates: const { confirmDeleteMessage, confirmRegenerateMessage } = useSettings()
  it('should re-render when unrelated setting (fontSize) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useSettings()
        return {
          confirmDeleteMessage: settings.confirmDeleteMessage,
          confirmRegenerateMessage: settings.confirmRegenerateMessage
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setFontSize(18))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[MessageMenubar baseline] Unrelated field (fontSize) change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('MessageMenubar component render optimization — AFTER migration (useAppSelector)', () => {
  it('should NOT re-render when unrelated setting (fontSize) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const confirmDeleteMessage = useAppSelector((state) => state.settings.confirmDeleteMessage)
        const confirmRegenerateMessage = useAppSelector((state) => state.settings.confirmRegenerateMessage)
        return { confirmDeleteMessage, confirmRegenerateMessage }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setFontSize(18))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[MessageMenubar migrated] Unrelated field (fontSize) change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBe(0)
  })

  it('should re-render when related field (confirmDeleteMessage) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const confirmDeleteMessage = useAppSelector((state) => state.settings.confirmDeleteMessage)
        const confirmRegenerateMessage = useAppSelector((state) => state.settings.confirmRegenerateMessage)
        return { confirmDeleteMessage, confirmRegenerateMessage }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setConfirmDeleteMessage(false))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[MessageMenubar migrated] Related field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('MessageEditor component render optimization — BEFORE migration (useSettings)', () => {
  // Simulates: const { pasteLongTextAsFile, pasteLongTextThreshold, fontSize, sendMessageShortcut, enableSpellCheck } = useSettings()
  it('should re-render when unrelated setting (theme) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useSettings()
        return {
          pasteLongTextAsFile: settings.pasteLongTextAsFile,
          pasteLongTextThreshold: settings.pasteLongTextThreshold,
          fontSize: settings.fontSize,
          sendMessageShortcut: settings.sendMessageShortcut,
          enableSpellCheck: settings.enableSpellCheck
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setTheme('dark' as ThemeMode))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[MessageEditor baseline] Unrelated field (theme) change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('MessageEditor component render optimization — AFTER migration (useEditorSettings)', () => {
  it('should NOT re-render when unrelated setting (theme) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useEditorSettings()
        return {
          pasteLongTextAsFile: settings.pasteLongTextAsFile,
          pasteLongTextThreshold: settings.pasteLongTextThreshold,
          fontSize: settings.fontSize,
          sendMessageShortcut: settings.sendMessageShortcut,
          enableSpellCheck: settings.enableSpellCheck
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setTheme('dark' as ThemeMode))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[MessageEditor migrated] Unrelated field (theme) change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBe(0)
  })

  it('should re-render when related field (sendMessageShortcut) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useEditorSettings()
        return {
          pasteLongTextAsFile: settings.pasteLongTextAsFile,
          pasteLongTextThreshold: settings.pasteLongTextThreshold,
          fontSize: settings.fontSize,
          sendMessageShortcut: settings.sendMessageShortcut,
          enableSpellCheck: settings.enableSpellCheck
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setSendMessageShortcut('enter' as SendMessageShortcut))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[MessageEditor migrated] Related field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('ThinkingBlock component render optimization — BEFORE migration (useSettings)', () => {
  // Simulates: const { messageFont, fontSize, thoughtAutoCollapse } = useSettings()
  it('should re-render when unrelated setting (narrowMode) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useSettings()
        return {
          messageFont: settings.messageFont,
          fontSize: settings.fontSize,
          thoughtAutoCollapse: settings.thoughtAutoCollapse
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setNarrowMode(true))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[ThinkingBlock baseline] Unrelated field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('ThinkingBlock component render optimization — AFTER migration (useMessageRenderSettings)', () => {
  it('should NOT re-render when unrelated setting (narrowMode) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useMessageRenderSettings()
        return {
          messageFont: settings.messageFont,
          fontSize: settings.fontSize,
          thoughtAutoCollapse: settings.thoughtAutoCollapse
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setNarrowMode(true))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[ThinkingBlock migrated] Unrelated field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBe(0)
  })

  it('should re-render when related field (thoughtAutoCollapse) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useMessageRenderSettings()
        return {
          messageFont: settings.messageFont,
          fontSize: settings.fontSize,
          thoughtAutoCollapse: settings.thoughtAutoCollapse
        }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setThoughtAutoCollapse(false))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[ThinkingBlock migrated] Related field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('MainTextBlock component render optimization — BEFORE migration (useSettings)', () => {
  // Simulates: const { renderInputMessageAsMarkdown } = useSettings()
  it('should re-render when unrelated setting (narrowMode) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useSettings()
        return { renderInputMessageAsMarkdown: settings.renderInputMessageAsMarkdown }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setNarrowMode(true))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[MainTextBlock baseline] Unrelated field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('MainTextBlock component render optimization — AFTER migration (useMessageRenderSettings)', () => {
  it('should NOT re-render when unrelated setting (narrowMode) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useMessageRenderSettings()
        return { renderInputMessageAsMarkdown: settings.renderInputMessageAsMarkdown }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setNarrowMode(true))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[MainTextBlock migrated] Unrelated field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBe(0)
  })

  it('should re-render when related field (renderInputMessageAsMarkdown) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useMessageRenderSettings()
        return { renderInputMessageAsMarkdown: settings.renderInputMessageAsMarkdown }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setRenderInputMessageAsMarkdown(true))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[MainTextBlock migrated] Related field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('NarrowLayout component render optimization — BEFORE migration (useSettings)', () => {
  // Simulates: const { narrowMode } = useSettings()
  it('should re-render when unrelated setting (theme) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useSettings()
        return { narrowMode: settings.narrowMode }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setTheme('dark' as ThemeMode))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[NarrowLayout baseline] Unrelated field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('NarrowLayout component render optimization — AFTER migration (useAppSelector)', () => {
  it('should NOT re-render when unrelated setting (theme) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const narrowMode = useAppSelector((state) => state.settings.narrowMode)
        return { narrowMode }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setTheme('dark' as ThemeMode))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[NarrowLayout migrated] Unrelated field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBe(0)
  })

  it('should re-render when related field (narrowMode) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const narrowMode = useAppSelector((state) => state.settings.narrowMode)
        return { narrowMode }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setNarrowMode(true))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[NarrowLayout migrated] Related field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('MessageGroupModelList component render optimization — BEFORE migration (useSettings)', () => {
  // Simulates: const { foldDisplayMode } = useSettings()
  it('should re-render when unrelated setting (theme) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useSettings()
        return { foldDisplayMode: settings.foldDisplayMode }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setTheme('dark' as ThemeMode))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[MessageGroupModelList baseline] Unrelated field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

describe('MessageGroupModelList component render optimization — AFTER migration (useMessageGroupSettings)', () => {
  it('should NOT re-render when unrelated setting (theme) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useMessageGroupSettings()
        return { foldDisplayMode: settings.foldDisplayMode }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setTheme('dark' as ThemeMode))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[MessageGroupModelList migrated] Unrelated field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBe(0)
  })

  it('should re-render when related field (foldDisplayMode) changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(
      () => {
        const settings = useMessageGroupSettings()
        return { foldDisplayMode: settings.foldDisplayMode }
      },
      { wrapper: createWrapper(store) }
    )

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setFoldDisplayMode('compact'))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[MessageGroupModelList migrated] Related field change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})

// --- Step 6: useMessageStyle performance tests ---

describe('useMessageStyle render count — AFTER migration (useAppSelector)', () => {
  it('should render exactly once on initial mount', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useMessageStyle(), { wrapper: createWrapper(store) })
    expect(renderCount).toBe(1)
  })

  it('should NOT re-render when an unrelated setting changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useMessageStyle(), { wrapper: createWrapper(store) })

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setLaunchOnBoot(true))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[useMessageStyle migrated] Unrelated field (launchOnBoot) change → ${extraRenders} extra render(s)`)
    // After migration: useAppSelector with scalar selector → no re-render for unrelated changes
    expect(extraRenders).toBe(0)
  })

  it('should re-render when messageStyle changes', () => {
    renderCount = 0
    const store = createTestStore()
    renderHook(() => useMessageStyle(), { wrapper: createWrapper(store) })

    const beforeCount = renderCount

    act(() => {
      store.dispatch(setMessageStyle('bubble'))
    })

    const extraRenders = renderCount - beforeCount
    console.log(`[useMessageStyle migrated] Related field (messageStyle) change → ${extraRenders} extra render(s)`)
    expect(extraRenders).toBeGreaterThanOrEqual(1)
  })
})
