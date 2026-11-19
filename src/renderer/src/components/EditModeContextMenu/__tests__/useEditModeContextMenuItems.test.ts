import { act, renderHook } from '@testing-library/react'
import i18next from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import enUs from '../../../i18n/locales/en-us.json'
import zhCn from '../../../i18n/locales/zh-cn.json'
import zhTw from '../../../i18n/locales/zh-tw.json'
import { useEditModeContextMenuItems } from '../useEditModeContextMenuItems'

/**
 * The fold action's labels and toasts are asserted through the REAL locale
 * bundle, so a placeholder or a raw key is a test failure rather than something
 * a hand-written `t` map could hide.
 */
let i18nInstance: ReturnType<typeof i18next.createInstance> | null = null

function getI18n(lng: string) {
  if (!i18nInstance || i18nInstance.language !== lng) {
    i18nInstance = i18next.createInstance()
    void i18nInstance.init({
      lng,
      fallbackLng: 'en-US',
      resources: {
        'zh-CN': { translation: zhCn },
        'zh-TW': { translation: zhTw },
        'en-US': { translation: enUs }
      },
      interpolation: { escapeValue: false },
      initImmediate: false
    })
  }
  return i18nInstance
}

let activeLanguage = 'zh-CN'

const { dispatchMock, dispatched, setTurnFoldsMock, mockEditMode } = vi.hoisted(() => {
  const dispatched: unknown[] = []
  const setTurnFoldsMock = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined)
  const dispatchMock = vi.fn((action: unknown) => {
    dispatched.push(action)
    // Real dispatch semantics for a thunk: the wrapper runs its payload.
    if (typeof action === 'function') return (action as () => unknown)()
    return action
  })
  const mockEditMode = {
    isEnabled: true,
    selectedGroupIds: [] as string[],
    handleCopy: vi.fn(),
    handleCut: vi.fn(),
    handlePaste: vi.fn(),
    handleDelete: vi.fn(),
    handleUndo: vi.fn(),
    handleRedo: vi.fn(),
    hasClipboard: false,
    canUndo: false,
    canRedo: false,
    groups: [] as any[],
    allMessageIds: [] as string[],
    getSelectedMessageIds: vi.fn(() => [] as string[]),
    selectionRouteCapability: 'owner' as const,
    isSelectionMutable: true
  }
  return { dispatchMock, dispatched, setTurnFoldsMock, mockEditMode }
})

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => dispatchMock,
  useAppSelector: (selector: any) =>
    selector({
      topicBranches: {},
      messages: {
        messageIdsByTopic: {},
        mutableMessageIdsByTopic: {}
      }
    })
}))

// The atomic turn-fold thunk keeps its real call contract; only its effect is
// recorded, so the hook's single command is observable.
vi.mock('@renderer/store/thunk/turnFold', () => ({
  setTurnFoldsThunk: (topicId: string, groupIds: string[], folded: boolean, branchId?: string | null) => () =>
    setTurnFoldsMock(topicId, groupIds, folded, branchId)
}))

vi.mock('@renderer/context/EditModeContext', () => ({
  useEditMode: () => mockEditMode
}))

vi.mock('@renderer/hooks/useTopicSegments', () => ({
  useTopicSegments: () => ({
    getSegmentsForTopic: () => []
  })
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => getI18n(activeLanguage).t(key, options),
    i18n: { language: activeLanguage }
  })
}))

const toggleFoldItem = (items: unknown[]) => items.find((item: any) => item?.key === 'toggleFoldSelected') as any

const runClick = async (item: any) => {
  await act(async () => {
    item.onClick()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useEditModeContextMenuItems - folding', () => {
  beforeEach(() => {
    activeLanguage = 'zh-CN'
    setTurnFoldsMock.mockReset()
    setTurnFoldsMock.mockImplementation(async () => undefined)
    dispatchMock.mockClear()
    dispatched.length = 0
    window.toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } as never
  })

  it('disables toggleFoldSelected when nothing is selected', () => {
    mockEditMode.selectedGroupIds = []
    mockEditMode.getSelectedMessageIds.mockReturnValue([])
    const { result } = renderHook(() => useEditModeContextMenuItems('topic-1'))
    const item = toggleFoldItem(result.current.items)
    expect(item).toBeDefined()
    expect(item.disabled).toBe(true)
    expect(item.label).toBe('折叠消息')
  })

  it('shows fold option and updates messages with folded: true when turns are not folded', async () => {
    mockEditMode.selectedGroupIds = ['g1']
    mockEditMode.groups = [
      {
        askId: 'g1',
        messages: [{ id: 'm1', folded: false }, { id: 'm2' }]
      }
    ]
    mockEditMode.getSelectedMessageIds.mockReturnValue(['m1', 'm2'])

    const { result } = renderHook(() => useEditModeContextMenuItems('topic-1'))
    const item = toggleFoldItem(result.current.items)
    expect(item).toBeDefined()
    expect(item.disabled).toBe(false)
    expect(item.label).toBe('折叠消息')

    await runClick(item)

    // ONE atomic command carrying the stable turn ids — never one write per row.
    expect(setTurnFoldsMock).toHaveBeenCalledTimes(1)
    expect(setTurnFoldsMock).toHaveBeenCalledWith('topic-1', ['g1'], true, null)
    // The command landed: the selection is consumed and the real resource is shown.
    expect(dispatched.filter((action) => typeof action !== 'function')).toHaveLength(1)
    expect(window.toast.success).toHaveBeenCalledWith('已折叠所选轮次')
    expect(window.toast.error).not.toHaveBeenCalled()
  })

  it('shows unfold option and updates messages with folded: null when all selected turns are folded', async () => {
    mockEditMode.selectedGroupIds = ['g1']
    mockEditMode.groups = [
      {
        askId: 'g1',
        messages: [
          { id: 'm1', folded: true },
          { id: 'm2', folded: true }
        ]
      }
    ]
    mockEditMode.getSelectedMessageIds.mockReturnValue(['m1', 'm2'])

    const { result } = renderHook(() => useEditModeContextMenuItems('topic-1'))
    const item = toggleFoldItem(result.current.items)
    expect(item).toBeDefined()
    expect(item.disabled).toBe(false)
    // The real menu wording (no "(restore context)" suffix, no raw key).
    expect(item.label).toBe('取消折叠')

    await runClick(item)

    expect(setTurnFoldsMock).toHaveBeenCalledTimes(1)
    expect(setTurnFoldsMock).toHaveBeenCalledWith('topic-1', ['g1'], false, null)
    expect(window.toast.success).toHaveBeenCalledWith('已取消折叠（恢复上下文）')
  })

  it('keeps the selection and reports a FOLD failure (never "failed to unfold") when a fold write is rejected', async () => {
    mockEditMode.selectedGroupIds = ['g1']
    mockEditMode.groups = [
      {
        askId: 'g1',
        messages: [{ id: 'm1', folded: false }, { id: 'm2' }]
      }
    ]
    mockEditMode.getSelectedMessageIds.mockReturnValue(['m1', 'm2'])
    setTurnFoldsMock.mockImplementation(async () => {
      throw new Error('write rejected')
    })

    const { result } = renderHook(() => useEditModeContextMenuItems('topic-1'))
    await runClick(toggleFoldItem(result.current.items))

    // A rejected write is never reported as success, and the selection survives
    // it (only the thunk dispatch happened — no selection clear).
    // The wording belongs to the operation the user asked for: this was a FOLD.
    expect(window.toast.error).toHaveBeenCalledWith('折叠失败，请重试')
    expect(window.toast.error).not.toHaveBeenCalledWith('取消折叠失败，请重试')
    expect(window.toast.success).not.toHaveBeenCalled()
    expect(dispatched.filter((action) => typeof action !== 'function')).toHaveLength(0)
  })

  it('reports an UNFOLD failure with the unfold wording', async () => {
    mockEditMode.selectedGroupIds = ['g1']
    mockEditMode.groups = [
      {
        askId: 'g1',
        messages: [{ id: 'm1', folded: true }]
      }
    ]
    mockEditMode.getSelectedMessageIds.mockReturnValue(['m1'])
    setTurnFoldsMock.mockImplementation(async () => {
      throw new Error('write rejected')
    })

    const { result } = renderHook(() => useEditModeContextMenuItems('topic-1'))
    await runClick(toggleFoldItem(result.current.items))

    expect(setTurnFoldsMock).toHaveBeenCalledWith('topic-1', ['g1'], false, null)
    expect(window.toast.error).toHaveBeenCalledWith('取消折叠失败，请重试')
    expect(window.toast.success).not.toHaveBeenCalled()
    expect(dispatched.filter((action) => typeof action !== 'function')).toHaveLength(0)
  })

  it('resolves the labels from the real English bundle and the real ZH-TW bundle', () => {
    mockEditMode.selectedGroupIds = ['g1']
    mockEditMode.groups = [
      {
        askId: 'g1',
        messages: [{ id: 'm1', folded: true }]
      }
    ]
    mockEditMode.getSelectedMessageIds.mockReturnValue(['m1'])

    activeLanguage = 'en-US'
    const english = renderHook(() => useEditModeContextMenuItems('topic-1'))
    expect(toggleFoldItem(english.result.current.items).label).toBe('Unfold')
    english.unmount()

    activeLanguage = 'zh-TW'
    const traditional = renderHook(() => useEditModeContextMenuItems('topic-1'))
    expect(toggleFoldItem(traditional.result.current.items).label).toBe('取消折疊')
  })
})
