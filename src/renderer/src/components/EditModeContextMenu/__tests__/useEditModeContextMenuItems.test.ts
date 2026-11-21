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

type MockBranch = {
  id: string
  topicId: string
  parentBranchId: string | null
  anchorMessageId: string
  createdAt?: string
}

const { dispatchMock, dispatched, setTurnFoldsMock, mockEditMode, mockState } = vi.hoisted(() => {
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
    selectedGroups: [] as any[],
    handleCopy: vi.fn(),
    handleCut: vi.fn(),
    handleCopyWithChildren: vi.fn(),
    handleCutWithChildren: vi.fn(),
    handlePaste: vi.fn(),
    handleDelete: vi.fn(),
    handleDeleteWithChildren: vi.fn(),
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
  // Minimal store projection: tests publish only the slices the hook reads, so
  // the branch catalog / route capability are set per case.
  const mockState = {
    messages: {
      messageIdsByTopic: {} as Record<string, string[]>,
      mutableMessageIdsByTopic: {} as Record<string, string[]>,
      mutableRouteByTopic: {} as Record<string, string | null>
    },
    topicBranch: {
      branchesByTopic: {} as Record<string, MockBranch[]>,
      activeBranchIdByTopic: {} as Record<string, string | null>
    }
  }
  return { dispatchMock, dispatched, setTurnFoldsMock, mockEditMode, mockState }
})

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => dispatchMock,
  useAppSelector: (selector: any) => selector(mockState)
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

const TOPIC = 'topic-1'

const itemByKey = (items: any[], key: string): any => {
  for (const item of items) {
    if (!item) continue
    if (item.key === key) return item
    if (Array.isArray(item.children)) {
      const nested = itemByKey(item.children, key)
      if (nested) return nested
    }
  }
  return undefined
}

const labelsOf = (items: any[]): unknown[] =>
  items.flatMap((item) => (item ? [item.label, ...(Array.isArray(item.children) ? labelsOf(item.children) : [])] : []))

const branchOf = (id: string, parentBranchId: string | null, anchorMessageId: string): MockBranch => ({
  id,
  topicId: TOPIC,
  parentBranchId,
  anchorMessageId
})

/**
 * Publish the minimum projection the relevance hint reads: the complete branch
 * catalog of the topic, the addressed route, the route the resident projection
 * belongs to, and the resolved selection. `branches: null` models a catalog that
 * was never received.
 */
function setTreeProjection(params: {
  branches: MockBranch[] | null
  activeBranchId?: string | null
  mutableRoute?: string | null
  selection?: { askId: string; memberIds: string[] }[]
  isSelectionMutable?: boolean
}) {
  const {
    branches,
    activeBranchId = null,
    mutableRoute = null,
    selection = [{ askId: 'g1', memberIds: ['m1', 'm2'] }],
    isSelectionMutable = true
  } = params
  mockState.topicBranch.branchesByTopic = {}
  if (branches !== null) mockState.topicBranch.branchesByTopic[TOPIC] = branches
  mockState.topicBranch.activeBranchIdByTopic = { [TOPIC]: activeBranchId }
  mockState.messages.mutableRouteByTopic = { [TOPIC]: mutableRoute }
  const groups = selection.map(({ askId, memberIds }) => ({
    askId,
    messages: memberIds.map((id) => ({ id }))
  }))
  mockEditMode.selectedGroupIds = groups.map((group) => group.askId)
  mockEditMode.groups = groups
  mockEditMode.selectedGroups = groups
  mockEditMode.isSelectionMutable = isSelectionMutable
}

describe('useEditModeContextMenuItems - including child branches', () => {
  beforeEach(() => {
    activeLanguage = 'zh-CN'
    mockEditMode.handleCopy.mockClear()
    mockEditMode.handleCut.mockClear()
    mockEditMode.handleCopyWithChildren.mockClear()
    mockEditMode.handleCutWithChildren.mockClear()
    mockEditMode.handleDelete.mockClear()
    mockEditMode.handleDeleteWithChildren.mockClear()
  })

  it('offers both tree options inside the copy/cut submenus when a selected turn anchors a direct child branch', async () => {
    // b1 is created on the addressed (main) route at message m2, which belongs
    // to the selected turn.
    setTreeProjection({ branches: [branchOf('b1', null, 'm2')] })
    const { result } = renderHook(() => useEditModeContextMenuItems(TOPIC))
    const items = result.current.items as any[]

    // The ordinary action keeps its key and stays one level in.
    expect(itemByKey(items, 'copy').children.map((child: any) => child.key)).toEqual([
      'copyOrdinary',
      'copyWithChildren'
    ])
    expect(itemByKey(items, 'copy').label).toBe('复制')
    expect(itemByKey(items, 'copyWithChildren').label).toBe('复制(含子分支)')
    expect(itemByKey(items, 'cut').children.map((child: any) => child.key)).toEqual(['cutOrdinary', 'cutWithChildren'])
    expect(itemByKey(items, 'cutWithChildren').label).toBe('剪切(含子分支)')
    // The submenu title only expands: it must never carry an onClick, so a click
    // on the parent cannot perform the ordinary copy/cut as a side effect.
    expect(itemByKey(items, 'copy').onClick).toBeUndefined()
    expect(itemByKey(items, 'cut').onClick).toBeUndefined()
    // The popup sits flush with the parent panel edge (no overlap, no seam):
    // the offset compensates the panel padding + hairline borders only.
    expect(itemByKey(items, 'copy').popupOffset).toEqual([5, 0])
    expect(itemByKey(items, 'cut').popupOffset).toEqual([5, 0])
    // The delete submenu of the same selection shares the identical offset, so
    // both flip directions stay flush with a single constant.
    expect(itemByKey(items, 'delete').children).toBeDefined()
    expect(itemByKey(items, 'delete').popupOffset).toEqual(itemByKey(items, 'copy').popupOffset)
    // Leaf rows carry no nested offset of their own: popups never stack.
    for (const leaf of [...itemByKey(items, 'copy').children, ...itemByKey(items, 'cut').children]) {
      expect(leaf.popupOffset).toBeUndefined()
    }

    await runClick(itemByKey(items, 'copyOrdinary'))
    expect(mockEditMode.handleCopy).toHaveBeenCalledTimes(1)
    expect(mockEditMode.handleCopyWithChildren).not.toHaveBeenCalled()
    await runClick(itemByKey(items, 'copyWithChildren'))
    expect(mockEditMode.handleCopyWithChildren).toHaveBeenCalledTimes(1)
    await runClick(itemByKey(items, 'cutOrdinary'))
    expect(mockEditMode.handleCut).toHaveBeenCalledTimes(1)
    await runClick(itemByKey(items, 'cutWithChildren'))
    expect(mockEditMode.handleCutWithChildren).toHaveBeenCalledTimes(1)
  })

  it('keeps plain single-click copy/cut when the child branch is anchored outside the selection', async () => {
    setTreeProjection({ branches: [branchOf('b1', null, 'm9')] })
    const { result } = renderHook(() => useEditModeContextMenuItems(TOPIC))
    const items = result.current.items as any[]

    expect(itemByKey(items, 'copy').children).toBeUndefined()
    expect(itemByKey(items, 'cut').children).toBeUndefined()
    expect(itemByKey(items, 'cut').disabled).toBe(false)
    // The ordinary leaf stays directly clickable and carries no popup offset.
    expect(itemByKey(items, 'copy').onClick).toBeDefined()
    expect(itemByKey(items, 'copy').popupOffset).toBeUndefined()
    expect(labelsOf(items)).not.toContain('chat.edit.copyTreeAction')
    expect(labelsOf(items)).not.toContain('chat.edit.cutTreeAction')
    await runClick(itemByKey(items, 'copy'))
    expect(mockEditMode.handleCopy).toHaveBeenCalledTimes(1)
    await runClick(itemByKey(items, 'cut'))
    expect(mockEditMode.handleCut).toHaveBeenCalledTimes(1)
  })

  it('hides the tree options when the anchor belongs to an ancestor level instead of the addressed route', () => {
    // Active route b2 sits under b1. The selection anchors m2 — a direct child
    // of the MAIN route and therefore a sibling of the addressed level — which
    // must never expose a tree capture of that sibling/ancestor subtree.
    setTreeProjection({
      branches: [branchOf('b1', null, 'm2'), branchOf('b2', 'b1', 'm3')],
      activeBranchId: 'b2',
      mutableRoute: 'b2',
      selection: [{ askId: 'g1', memberIds: ['m2'] }]
    })
    const { result } = renderHook(() => useEditModeContextMenuItems(TOPIC))
    const items = result.current.items as any[]

    expect(itemByKey(items, 'copy').children).toBeUndefined()
    expect(itemByKey(items, 'cut').children).toBeUndefined()
  })

  it('hides the tree options when the addressed route has no child branch at all', () => {
    setTreeProjection({ branches: [] })
    const { result } = renderHook(() => useEditModeContextMenuItems(TOPIC))
    expect(itemByKey(result.current.items as any[], 'copy').children).toBeUndefined()
  })

  it('hides the tree options when the branch catalog was never received (fail closed)', () => {
    setTreeProjection({ branches: null })
    const { result } = renderHook(() => useEditModeContextMenuItems(TOPIC))
    const items = result.current.items as any[]
    expect(itemByKey(items, 'copy').children).toBeUndefined()
    expect(labelsOf(items)).not.toContain('chat.edit.copyTreeAction')
  })

  it('hides the tree options when the catalog is incomplete/stale', () => {
    // A branch naming a parent the catalog does not hold: the catalog cannot be
    // trusted as a hint, even though b1 looks relevant.
    setTreeProjection({ branches: [branchOf('b1', null, 'm2'), branchOf('b2', 'missing', 'm3')] })
    const { result } = renderHook(() => useEditModeContextMenuItems(TOPIC))
    expect(itemByKey(result.current.items as any[], 'copy').children).toBeUndefined()
  })

  it('hides the tree options when the resident projection belongs to another route', () => {
    setTreeProjection({
      branches: [branchOf('b1', null, 'm2'), branchOf('b2', 'b1', 'm2')],
      activeBranchId: 'b1',
      mutableRoute: 'b2'
    })
    const { result } = renderHook(() => useEditModeContextMenuItems(TOPIC))
    expect(itemByKey(result.current.items as any[], 'copy').children).toBeUndefined()
  })

  it('hides the tree options for an unresolved selection', () => {
    setTreeProjection({ branches: [branchOf('b1', null, 'm2')] })
    // One selected turn did not resolve to member ids.
    mockEditMode.selectedGroupIds = ['g1', 'g2']
    mockEditMode.selectedGroups = [{ askId: 'g1', messages: [{ id: 'm1' }, { id: 'm2' }] }]
    const { result } = renderHook(() => useEditModeContextMenuItems(TOPIC))
    expect(itemByKey(result.current.items as any[], 'copy').children).toBeUndefined()
  })

  it('never offers a tree cut for a non-writable selection while tree copy stays available', () => {
    setTreeProjection({ branches: [branchOf('b1', null, 'm2')], isSelectionMutable: false })
    const { result } = renderHook(() => useEditModeContextMenuItems(TOPIC))
    const items = result.current.items as any[]

    expect(itemByKey(items, 'copyWithChildren')).toBeTruthy()
    // The ordinary cut keeps its usual disabled state and grows no submenu.
    expect(itemByKey(items, 'cut').children).toBeUndefined()
    expect(itemByKey(items, 'cut').disabled).toBe(true)
    expect(itemByKey(items, 'cutWithChildren')).toBeUndefined()
    expect(labelsOf(items)).not.toContain('chat.edit.cutTreeAction')
  })

  it('resolves the tree option labels from the real bundles', () => {
    setTreeProjection({ branches: [branchOf('b1', null, 'm2')] })

    activeLanguage = 'en-US'
    const english = renderHook(() => useEditModeContextMenuItems(TOPIC))
    expect(itemByKey(english.result.current.items as any[], 'copyWithChildren').label).toBe(
      'Copy including child branches'
    )
    expect(itemByKey(english.result.current.items as any[], 'cutWithChildren').label).toBe(
      'Cut including child branches'
    )
    english.unmount()

    activeLanguage = 'zh-TW'
    const traditional = renderHook(() => useEditModeContextMenuItems(TOPIC))
    expect(itemByKey(traditional.result.current.items as any[], 'copyWithChildren').label).toBe('複製(含子分支)')
    expect(itemByKey(traditional.result.current.items as any[], 'cutWithChildren').label).toBe('剪下(含子分支)')
  })
})

describe('useEditModeContextMenuItems - delete including child branches', () => {
  beforeEach(() => {
    activeLanguage = 'zh-CN'
    mockEditMode.handleDelete.mockClear()
    mockEditMode.handleDeleteWithChildren.mockClear()
  })
  it('offers the tree delete inside the delete submenu when a selected turn anchors a direct child branch', async () => {
    setTreeProjection({ branches: [branchOf('b1', null, 'm2')] })
    const { result } = renderHook(() => useEditModeContextMenuItems(TOPIC))
    const items = result.current.items as any[]

    expect(itemByKey(items, 'delete').children.map((child: any) => child.key)).toEqual([
      'deleteOrdinary',
      'deleteWithChildren'
    ])
    expect(itemByKey(items, 'delete').label).toBe('删除')
    expect(itemByKey(items, 'deleteWithChildren').label).toBe('删除(含子分支)')
    // The submenu title only expands: it must never carry an onClick, so a
    // click on the parent cannot perform the ordinary delete as a side effect.
    expect(itemByKey(items, 'delete').onClick).toBeUndefined()
    // The popup sits flush with the parent panel edge (no overlap, no seam).
    expect(itemByKey(items, 'delete').popupOffset).toEqual([5, 0])
    // The delete leaf rows carry no nested offset of their own.
    for (const leaf of itemByKey(items, 'delete').children) {
      expect(leaf.popupOffset).toBeUndefined()
    }

    await runClick(itemByKey(items, 'deleteOrdinary'))
    expect(mockEditMode.handleDelete).toHaveBeenCalledTimes(1)
    expect(mockEditMode.handleDeleteWithChildren).not.toHaveBeenCalled()
    await runClick(itemByKey(items, 'deleteWithChildren'))
    expect(mockEditMode.handleDeleteWithChildren).toHaveBeenCalledTimes(1)
  })

  it('keeps plain single-click delete when the child branch is anchored outside the selection', async () => {
    setTreeProjection({ branches: [branchOf('b1', null, 'm9')] })
    const { result } = renderHook(() => useEditModeContextMenuItems(TOPIC))
    const items = result.current.items as any[]

    expect(itemByKey(items, 'delete').children).toBeUndefined()
    expect(itemByKey(items, 'delete').onClick).toBeDefined()
    expect(itemByKey(items, 'delete').popupOffset).toBeUndefined()
    expect(labelsOf(items)).not.toContain('chat.edit.deleteTreeAction')
    await runClick(itemByKey(items, 'delete'))
    expect(mockEditMode.handleDelete).toHaveBeenCalledTimes(1)
    expect(mockEditMode.handleDeleteWithChildren).not.toHaveBeenCalled()
  })

  it('never offers a tree delete for a non-writable selection while the ordinary delete stays', async () => {
    setTreeProjection({ branches: [branchOf('b1', null, 'm2')], isSelectionMutable: false })
    const { result } = renderHook(() => useEditModeContextMenuItems(TOPIC))
    const items = result.current.items as any[]

    // The ordinary delete keeps its usual disabled state and grows no submenu.
    expect(itemByKey(items, 'delete').children).toBeUndefined()
    expect(itemByKey(items, 'delete').disabled).toBe(true)
    expect(itemByKey(items, 'deleteWithChildren')).toBeUndefined()
    expect(labelsOf(items)).not.toContain('chat.edit.deleteTreeAction')
  })

  it('resolves the tree delete label from the real English bundle', () => {
    setTreeProjection({ branches: [branchOf('b1', null, 'm2')] })

    activeLanguage = 'en-US'
    const english = renderHook(() => useEditModeContextMenuItems(TOPIC))
    expect(itemByKey(english.result.current.items as any[], 'deleteWithChildren').label).toBe(
      'Delete including child branches'
    )
    english.unmount()
  })
})
