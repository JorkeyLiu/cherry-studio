/**
 * moveSelectedTurnsToNewBranchThunk — bounded gating.
 *
 * - Route mismatch / unknown source / unresolved / non-owned / noncontiguous /
 *   no preceding / preceding non-owned / branch anchor / unknown catalog /
 *   segment cut make zero IPC calls and return null.
 * - Owned continuous selection with preceding anchor succeeds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: {
    moveSelectedTurnsToNewBranch: vi.fn(),
    listBranches: vi.fn(),
    fetchMessagesWindow: vi.fn(),
    dispatch: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), silly: vi.fn() })
  }
}))
vi.mock('@renderer/services/db', () => ({
  dbService: {
    moveSelectedTurnsToNewBranch: mocks.moveSelectedTurnsToNewBranch,
    listBranches: mocks.listBranches,
    fetchMessagesWindow: mocks.fetchMessagesWindow,
    resolveContextClosure: vi.fn().mockResolvedValue({ resolvedAnchorGroupKey: null })
  }
}))
vi.mock('@renderer/store/newMessage', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    newMessagesActions: {
      ...actual.newMessagesActions,
      messagesReceived: vi.fn((p: unknown) => ({ type: 'messagesReceived', payload: p })),
      invalidateRouteMutability: vi.fn((p: unknown) => ({ type: 'invalidateRouteMutability', payload: p })),
      rebaseRouteMessages: vi.fn((p: unknown) => ({ type: 'rebaseRouteMessages', payload: p })),
      setTopicLoading: vi.fn((p: unknown) => ({ type: 'setTopicLoading', payload: p }))
    }
  }
})
vi.mock('@renderer/store/messageBlock', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual, upsertManyBlocks: vi.fn((p: unknown) => ({ type: 'upsertManyBlocks', payload: p })) }
})
vi.mock('@renderer/store/closureOwnership', () => ({
  withClosureTopics: (action: unknown) => action
}))

function turnEntities(ids: string[]): Record<string, any> {
  const entities: Record<string, any> = {}
  for (let i = 0; i < ids.length; i += 2) {
    const u = ids[i]
    const a = ids[i + 1]
    entities[u] = { id: u, role: 'user', askId: null }
    if (a) entities[a] = { id: a, role: 'assistant', askId: u }
  }
  return entities
}

function moveState(opts: {
  active: string | null
  loaded: string[]
  mutable: string[]
  selected: string[]
  catalog?: { id: string; anchorMessageId: string }[]
  segments?: Record<string, { messageIds: string[] }>
}) {
  const branches = (opts.catalog ?? []).map((b) => ({
    id: b.id,
    topicId: 't-1',
    parentBranchId: null,
    anchorMessageId: b.anchorMessageId,
    name: b.id,
    createdAt: null,
    updatedAt: null
  }))
  return {
    topicBranch: {
      branchesByTopic: opts.catalog === undefined ? {} : { 't-1': branches },
      activeBranchIdByTopic: opts.active === null ? {} : { 't-1': opts.active },
      routeGenerationByTopic: { 't-1': 1 },
      deletionFallbackByTopic: {}
    },
    messages: {
      entities: turnEntities(opts.loaded),
      ids: opts.loaded,
      messageIdsByTopic: { 't-1': opts.loaded },
      mutableMessageIdsByTopic: { 't-1': opts.mutable },
      mutableRouteByTopic: { 't-1': opts.active },
      displayCount: 20,
      loadingByTopic: {},
      currentTopicId: 't-1'
    },
    messageBlocks: { entities: {}, ids: [] },
    editMode: { enabled: true, selectedGroupIds: opts.selected, lastSelectedIndex: null, focusedIndex: null },
    topicSegments: {
      segmentsByTopic: opts.segments ? { 't-1': Object.keys(opts.segments) } : {},
      segments: {
        entities: Object.fromEntries(Object.entries(opts.segments ?? {}).map(([id, s]) => [id, { id, ...s }]))
      }
    },
    assistants: { assistants: [] }
  }
}

const LOADED = ['uA', 'aA', 'uB', 'aB', 'uC', 'aC', 'uD', 'aD']

describe('moveSelectedTurnsToNewBranchThunk gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.moveSelectedTurnsToNewBranch.mockResolvedValue({
      branch: { id: 'nb', anchorMessageId: 'aA' },
      movedMessageIds: ['uB', 'aB', 'uC', 'aC'],
      anchorMessageId: 'aA',
      messages: [],
      blocks: []
    })
    mocks.listBranches.mockResolvedValue({ branches: [] })
    mocks.fetchMessagesWindow.mockResolvedValue({
      messages: [],
      blocks: [],
      window: { kind: 'latest' },
      mutableMessageIds: []
    })
  })

  it('owned continuous selection succeeds with one IPC', async () => {
    const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
    const state = moveState({ active: null, loaded: LOADED, mutable: LOADED, selected: ['uB', 'uC'], catalog: [] })
    const res = await moveSelectedTurnsToNewBranchThunk(
      't-1',
      null,
      ['uB', 'uC'],
      'Moved'
    )(mocks.dispatch as any, (() => state) as any)
    expect(res).not.toBeNull()
    expect(mocks.moveSelectedTurnsToNewBranch).toHaveBeenCalledOnce()
  })

  it('source route mismatch makes zero IPC', async () => {
    const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
    const state = moveState({ active: null, loaded: LOADED, mutable: LOADED, selected: ['uB', 'uC'], catalog: [] })
    const res = await moveSelectedTurnsToNewBranchThunk(
      't-1',
      'b-other',
      ['uB', 'uC'],
      'Moved'
    )(mocks.dispatch as any, (() => state) as any)
    expect(res).toBeNull()
    expect(mocks.moveSelectedTurnsToNewBranch).not.toHaveBeenCalled()
  })

  it('non-owned selection makes zero IPC', async () => {
    const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
    const state = moveState({
      active: null,
      loaded: LOADED,
      mutable: ['uA', 'aA', 'uD', 'aD'],
      selected: ['uB', 'uC'],
      catalog: []
    })
    const res = await moveSelectedTurnsToNewBranchThunk(
      't-1',
      null,
      ['uB', 'uC'],
      'Moved'
    )(mocks.dispatch as any, (() => state) as any)
    expect(res).toBeNull()
    expect(mocks.moveSelectedTurnsToNewBranch).not.toHaveBeenCalled()
  })

  it('noncontiguous selection makes zero IPC', async () => {
    const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
    const state = moveState({ active: null, loaded: LOADED, mutable: LOADED, selected: ['uB', 'uD'], catalog: [] })
    const res = await moveSelectedTurnsToNewBranchThunk(
      't-1',
      null,
      ['uB', 'uD'],
      'Moved'
    )(mocks.dispatch as any, (() => state) as any)
    expect(res).toBeNull()
    expect(mocks.moveSelectedTurnsToNewBranch).not.toHaveBeenCalled()
  })

  it('first-turn selection with no preceding anchor makes zero IPC', async () => {
    const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
    const state = moveState({ active: null, loaded: LOADED, mutable: LOADED, selected: ['uA'], catalog: [] })
    const res = await moveSelectedTurnsToNewBranchThunk(
      't-1',
      null,
      ['uA'],
      'Moved'
    )(mocks.dispatch as any, (() => state) as any)
    expect(res).toBeNull()
    expect(mocks.moveSelectedTurnsToNewBranch).not.toHaveBeenCalled()
  })

  it('selection holding a branch anchor makes zero IPC', async () => {
    const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
    const state = moveState({
      active: null,
      loaded: LOADED,
      mutable: LOADED,
      selected: ['uB', 'uC'],
      catalog: [{ id: 'b1', anchorMessageId: 'aB' }]
    })
    const res = await moveSelectedTurnsToNewBranchThunk(
      't-1',
      null,
      ['uB', 'uC'],
      'Moved'
    )(mocks.dispatch as any, (() => state) as any)
    expect(res).toBeNull()
    expect(mocks.moveSelectedTurnsToNewBranch).not.toHaveBeenCalled()
  })

  it('unknown catalog makes zero IPC', async () => {
    const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
    const state = moveState({ active: null, loaded: LOADED, mutable: LOADED, selected: ['uB', 'uC'] })
    delete (state.topicBranch.branchesByTopic as Record<string, unknown>)['t-1']
    const res = await moveSelectedTurnsToNewBranchThunk(
      't-1',
      null,
      ['uB', 'uC'],
      'Moved'
    )(mocks.dispatch as any, (() => state) as any)
    expect(res).toBeNull()
    expect(mocks.moveSelectedTurnsToNewBranch).not.toHaveBeenCalled()
  })

  it('segment cutting the selection makes zero IPC', async () => {
    const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
    const state = moveState({
      active: null,
      loaded: LOADED,
      mutable: LOADED,
      selected: ['uB'],
      catalog: [],
      segments: { 'seg-1': { messageIds: ['uB', 'aB', 'uC'] } }
    })
    const res = await moveSelectedTurnsToNewBranchThunk(
      't-1',
      null,
      ['uB'],
      'Moved'
    )(mocks.dispatch as any, (() => state) as any)
    expect(res).toBeNull()
    expect(mocks.moveSelectedTurnsToNewBranch).not.toHaveBeenCalled()
  })

  it('sends display-ordered expected IDs even when input order is reversed', async () => {
    const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
    const state = moveState({ active: null, loaded: LOADED, mutable: LOADED, selected: ['uC', 'uB'], catalog: [] })
    const res = await moveSelectedTurnsToNewBranchThunk(
      't-1',
      null,
      ['uC', 'uB'],
      'Moved'
    )(mocks.dispatch as any, (() => state) as any)
    expect(res).not.toBeNull()
    expect(mocks.moveSelectedTurnsToNewBranch).toHaveBeenCalledOnce()
    const args = mocks.moveSelectedTurnsToNewBranch.mock.calls[0] as unknown[]
    expect(args[1]).toBeNull()
    expect(args[2]).toEqual(['uC', 'uB'])
    expect(args[4]).toEqual(['uB', 'aB', 'uC', 'aC'])
  })

  it('orphan group root outside the loaded window makes zero IPC', async () => {
    const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
    const state = moveState({ active: null, loaded: LOADED, mutable: LOADED, selected: ['uZ'], catalog: [] })
    const res = await moveSelectedTurnsToNewBranchThunk(
      't-1',
      null,
      ['uZ'],
      'Moved'
    )(mocks.dispatch as any, (() => state) as any)
    expect(res).toBeNull()
    expect(mocks.moveSelectedTurnsToNewBranch).not.toHaveBeenCalled()
  })

  it('route generation change before IPC makes zero IPC (away-and-back)', async () => {
    const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
    const entryState = moveState({
      active: null,
      loaded: LOADED,
      mutable: LOADED,
      selected: ['uB', 'uC'],
      catalog: []
    })
    const changedState = {
      ...entryState,
      topicBranch: {
        ...entryState.topicBranch,
        activeBranchIdByTopic: {},
        routeGenerationByTopic: { 't-1': 2 }
      }
    }
    let calls = 0
    const getState = (): unknown => {
      calls++
      // Entry read (before the import await) sees generation 1; the fresh
      // pre-IPC read sees generation 2 (user moved away and back).
      return calls === 1 ? entryState : changedState
    }
    const res = await moveSelectedTurnsToNewBranchThunk(
      't-1',
      null,
      ['uB', 'uC'],
      'Moved'
    )(mocks.dispatch as any, getState as any)
    expect(res).toBeNull()
    expect(mocks.moveSelectedTurnsToNewBranch).not.toHaveBeenCalled()
  })

  it('user move during commit preserves their route and still returns committed success', async () => {
    const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
    const sourceState = moveState({
      active: null,
      loaded: LOADED,
      mutable: LOADED,
      selected: ['uB', 'uC'],
      catalog: []
    })
    const movedState = {
      ...sourceState,
      topicBranch: {
        ...sourceState.topicBranch,
        activeBranchIdByTopic: { 't-1': 'b-user' },
        routeGenerationByTopic: { 't-1': 2 },
        branchesByTopic: {
          't-1': [
            {
              id: 'b-user',
              topicId: 't-1',
              parentBranchId: null,
              anchorMessageId: 'aA',
              name: 'b-user',
              createdAt: null,
              updatedAt: null
            }
          ]
        }
      }
    }
    let current: unknown = sourceState
    let resolveMove!: (v: unknown) => void
    const moveGate = new Promise<unknown>((r) => (resolveMove = r))
    // Mutate to the user-moved state exactly when the IPC is invoked (after
    // the fresh pre-IPC gate has passed on the source state), so the
    // post-commit guard observes the route change during the commit await.
    mocks.moveSelectedTurnsToNewBranch.mockImplementationOnce(() => {
      current = movedState
      return moveGate
    })
    const localDispatch = vi.fn()
    const p = moveSelectedTurnsToNewBranchThunk(
      't-1',
      null,
      ['uB', 'uC'],
      'Moved'
    )(localDispatch as any, (() => current) as any)
    // Let the thunk reach the IPC await (past the dynamic import), then
    // resolve the commit while the user-moved state is current.
    await new Promise<void>((r) => setTimeout(r, 0))
    resolveMove({
      branch: { id: 'nb', anchorMessageId: 'aA' },
      movedMessageIds: ['uB', 'aB', 'uC', 'aC'],
      anchorMessageId: 'aA',
      messages: [],
      blocks: []
    })
    const res = (await p) as unknown as { branchId: string } | null
    expect(res).not.toBeNull()
    expect(res?.branchId).toBe('nb')
    const activeSets = localDispatch.mock.calls
      .map((c) => c[0])
      .filter((a) => a && typeof a === 'object' && (a as { type?: string }).type === 'topicBranch/activeBranchSet')
    // No forced navigation to the new branch: the user's route is preserved.
    expect(activeSets).toEqual([])
  })

  it('new-route load throw still returns committed success with an explicit empty fail-closed window', async () => {
    const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
    const sourceState = moveState({
      active: null,
      loaded: LOADED,
      mutable: LOADED,
      selected: ['uB', 'uC'],
      catalog: []
    })
    // After activeBranchSet the store reflects the new-active route; the
    // subsequent route load then throws (DB already committed).
    let current: unknown = sourceState
    const localDispatch = vi.fn((action: unknown) => {
      if (typeof action === 'function') {
        throw new Error('injected new-route load failure')
      }
      const maybeType = (action as { type?: string })?.type
      if (maybeType === 'topicBranch/activeBranchSet') {
        const branchId = (action as { payload: { branchId: string } }).payload.branchId
        current = {
          ...(current as object),
          topicBranch: {
            ...(current as { topicBranch: object }).topicBranch,
            activeBranchIdByTopic: { 't-1': branchId },
            routeGenerationByTopic: { 't-1': 2 }
          }
        }
      }
      return action
    })
    const res = (await moveSelectedTurnsToNewBranchThunk(
      't-1',
      null,
      ['uB', 'uC'],
      'Moved'
    )(localDispatch as any, (() => current) as any)) as unknown as { branchId: string } | null
    expect(res).not.toBeNull()
    expect(res?.branchId).toBe('nb')
    const rebases = localDispatch.mock.calls
      .map((c) => c[0])
      .filter(
        (a) =>
          a &&
          typeof a === 'object' &&
          typeof (a as { type?: string }).type === 'string' &&
          ((a as { type: string }).type === 'newMessages/rebaseRouteMessages' ||
            (a as { type: string }).type === 'rebaseRouteMessages')
      )
    // Stale source window cleared on the new-active route (explicit empty,
    // never stale source messages under the new route).
    expect(rebases.length).toBeGreaterThanOrEqual(1)
    const last = rebases[rebases.length - 1] as { payload: { messages: unknown[]; route: string } }
    expect(last.payload.messages).toEqual([])
    expect(last.payload.route).toBe('nb')
  })

  it('superseded new-route load (void) preserves the current route and returns committed success', async () => {
    const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
    const sourceState = moveState({
      active: null,
      loaded: LOADED,
      mutable: LOADED,
      selected: ['uB', 'uC'],
      catalog: []
    })
    let current: unknown = sourceState
    const localDispatch = vi.fn((action: unknown) => {
      if (typeof action === 'function') {
        // Superseded read: resolves void with no rebase. Simulate the user
        // having moved elsewhere during the load.
        current = {
          ...(current as object),
          topicBranch: {
            ...(current as { topicBranch: object }).topicBranch,
            activeBranchIdByTopic: { 't-1': 'b-user' },
            routeGenerationByTopic: { 't-1': 3 }
          }
        }
        return Promise.resolve(undefined)
      }
      const maybeType = (action as { type?: string })?.type
      if (maybeType === 'topicBranch/activeBranchSet') {
        const branchId = (action as { payload: { branchId: string } }).payload.branchId
        current = {
          ...(current as object),
          topicBranch: {
            ...(current as { topicBranch: object }).topicBranch,
            activeBranchIdByTopic: { 't-1': branchId },
            routeGenerationByTopic: { 't-1': 2 }
          }
        }
      }
      return action
    })
    const res = (await moveSelectedTurnsToNewBranchThunk(
      't-1',
      null,
      ['uB', 'uC'],
      'Moved'
    )(localDispatch as any, (() => current) as any)) as unknown as { branchId: string } | null
    expect(res).not.toBeNull()
    expect(res?.branchId).toBe('nb')
  })

  // ---------------------------------------------------------------------------
  // Context-window anchor persistence on the committed move
  //
  // The destination anchor is a Main-resolved fact returned with the committed
  // move. It is written into the correct route key BEFORE the thunk's own
  // activeBranchSet and regardless of what the viewport load does afterwards
  // (superseded/void, throw, or the user switching route).
  // ---------------------------------------------------------------------------

  type MoveStateOpts = Parameters<typeof moveState>[0]

  function stateWithOwner(
    opts: MoveStateOpts,
    settings?: { contextWindowAnchor?: Record<string, unknown>; contextCount?: number | null }
  ) {
    const state = moveState(opts) as unknown as Record<string, any>
    state.assistants = {
      assistants: [
        {
          id: 'asst-1',
          topics: [{ id: 't-1' }],
          settings: { contextCount: 25, ...settings }
        }
      ]
    }
    return state
  }

  function actionsOfType(dispatchMock: { mock: { calls: unknown[][] } }, type: string): unknown[] {
    return dispatchMock.mock.calls
      .map((c) => c[0])
      .filter((a) => a && typeof a === 'object' && (a as { type?: string }).type === type)
  }

  function indexOfFirstAction(dispatchMock: { mock: { calls: unknown[][] } }, type: string): number {
    return dispatchMock.mock.calls.findIndex(
      (c) => c[0] && typeof c[0] === 'object' && ((c[0] as { type?: string }).type ?? '') === type
    )
  }

  describe('moveSelectedTurnsToNewBranchThunk context-anchor inheritance', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      mocks.listBranches.mockResolvedValue({ branches: [] })
      mocks.fetchMessagesWindow.mockResolvedValue({
        messages: [],
        blocks: [],
        window: { kind: 'latest' },
        mutableMessageIds: []
      })
    })

    it('sends the pre-commit source anchor and contextCount with the move request', async () => {
      const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
      mocks.moveSelectedTurnsToNewBranch.mockResolvedValue({
        branch: { id: 'nb', anchorMessageId: 'aA' },
        movedMessageIds: ['uB', 'aB', 'uC', 'aC'],
        anchorMessageId: 'aA',
        messages: [],
        blocks: [],
        resolvedContextAnchorGroupKey: 'uA'
      })
      const state = stateWithOwner(
        { active: null, loaded: LOADED, mutable: LOADED, selected: ['uB', 'uC'], catalog: [] },
        { contextWindowAnchor: { 't-1': { kind: 'active', groupKey: 'uA' } }, contextCount: 25 }
      )
      await moveSelectedTurnsToNewBranchThunk(
        't-1',
        null,
        ['uB', 'uC'],
        'Moved'
      )(mocks.dispatch as any, (() => state) as any)
      const args = mocks.moveSelectedTurnsToNewBranch.mock.calls[0] as unknown[]
      expect(args[5]).toEqual({ sourceAnchorGroupKey: 'uA', contextCount: 25 })
    })

    it('writes the committed destination anchor before activating the new route when the viewport load is superseded (void)', async () => {
      const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
      mocks.moveSelectedTurnsToNewBranch.mockResolvedValue({
        branch: { id: 'nb', anchorMessageId: 'aA' },
        movedMessageIds: ['uB', 'aB', 'uC', 'aC'],
        anchorMessageId: 'aA',
        messages: [],
        blocks: [],
        resolvedContextAnchorGroupKey: 'uD'
      })
      let current = stateWithOwner(
        { active: null, loaded: LOADED, mutable: LOADED, selected: ['uB', 'uC'], catalog: [] },
        { contextWindowAnchor: { 't-1': { kind: 'active', groupKey: 'uD' } }, contextCount: 25 }
      )
      const localDispatch = vi.fn((action: unknown) => {
        // Superseded viewport read: resolves void, no rebase (the deterministic
        // reproduction of the reported lost-inheritance path).
        if (typeof action === 'function') return Promise.resolve(undefined)
        const type = (action as { type?: string })?.type
        if (type === 'assistants/updateAssistantSettings') {
          const payload = (action as { payload: any }).payload
          current.assistants.assistants[0].settings = {
            ...current.assistants.assistants[0].settings,
            ...payload.settings
          }
        }
        if (type === 'topicBranch/activeBranchSet') {
          const branchId = (action as { payload: { branchId: string } }).payload.branchId
          current = {
            ...current,
            topicBranch: {
              ...current.topicBranch,
              activeBranchIdByTopic: { 't-1': branchId },
              routeGenerationByTopic: { 't-1': 2 }
            }
          }
        }
        return action
      })
      const res = (await moveSelectedTurnsToNewBranchThunk(
        't-1',
        null,
        ['uB', 'uC'],
        'Moved'
      )(localDispatch as any, (() => current) as any)) as unknown as { branchId: string } | null
      expect(res?.branchId).toBe('nb')
      const anchorWrites = actionsOfType(localDispatch, 'assistants/updateAssistantSettings')
      expect(anchorWrites).toHaveLength(1)
      const write = anchorWrites[0] as { payload: { settings: { contextWindowAnchor: Record<string, unknown> } } }
      // Correct route key, Main-resolved value, source key untouched.
      expect(write.payload.settings.contextWindowAnchor['t-1:nb']).toEqual({ kind: 'active', groupKey: 'uD' })
      expect(write.payload.settings.contextWindowAnchor['t-1']).toEqual({ kind: 'active', groupKey: 'uD' })
      // Written BEFORE the thunk's own activeBranchSet.
      const anchorIdx = indexOfFirstAction(localDispatch, 'assistants/updateAssistantSettings')
      const activeIdx = indexOfFirstAction(localDispatch, 'topicBranch/activeBranchSet')
      expect(activeIdx).toBeGreaterThan(-1)
      expect(anchorIdx).toBeGreaterThan(-1)
      expect(anchorIdx).toBeLessThan(activeIdx)
    })

    it('writes against the latest owner map so a concurrent write to another route survives the await gap', async () => {
      const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
      let current = stateWithOwner(
        { active: null, loaded: LOADED, mutable: LOADED, selected: ['uB', 'uC'], catalog: [] },
        { contextWindowAnchor: {}, contextCount: 25 }
      )
      mocks.moveSelectedTurnsToNewBranch.mockImplementationOnce(() => {
        // Another route's anchor lands while the commit is in flight.
        current.assistants.assistants[0].settings = {
          ...current.assistants.assistants[0].settings,
          contextWindowAnchor: { 't-1:b-other': { kind: 'active', groupKey: 'uX' } }
        }
        return Promise.resolve({
          branch: { id: 'nb', anchorMessageId: 'aA' },
          movedMessageIds: ['uB', 'aB', 'uC', 'aC'],
          anchorMessageId: 'aA',
          messages: [],
          blocks: [],
          resolvedContextAnchorGroupKey: 'uA'
        })
      })
      const localDispatch = vi.fn((action: unknown) => {
        if (typeof action === 'function') return Promise.resolve(undefined)
        const type = (action as { type?: string })?.type
        if (type === 'assistants/updateAssistantSettings') {
          const payload = (action as { payload: any }).payload
          current.assistants.assistants[0].settings = {
            ...current.assistants.assistants[0].settings,
            ...payload.settings
          }
        }
        if (type === 'topicBranch/activeBranchSet') {
          current = {
            ...current,
            topicBranch: {
              ...current.topicBranch,
              activeBranchIdByTopic: { 't-1': (action as { payload: { branchId: string } }).payload.branchId },
              routeGenerationByTopic: { 't-1': 2 }
            }
          }
        }
        return action
      })
      await moveSelectedTurnsToNewBranchThunk(
        't-1',
        null,
        ['uB', 'uC'],
        'Moved'
      )(localDispatch as any, (() => current) as any)
      const anchorWrites = actionsOfType(localDispatch, 'assistants/updateAssistantSettings')
      expect(anchorWrites).toHaveLength(1)
      const write = anchorWrites[0] as { payload: { settings: { contextWindowAnchor: Record<string, unknown> } } }
      // No skipped anchor, no clobbered foreign route key.
      expect(write.payload.settings.contextWindowAnchor['t-1:nb']).toEqual({ kind: 'active', groupKey: 'uA' })
      expect(write.payload.settings.contextWindowAnchor['t-1:b-other']).toEqual({ kind: 'active', groupKey: 'uX' })
    })

    it('writes the destination anchor even when the user switched route during the commit', async () => {
      const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
      let current = stateWithOwner(
        { active: null, loaded: LOADED, mutable: LOADED, selected: ['uB', 'uC'], catalog: [] },
        { contextWindowAnchor: {}, contextCount: 25 }
      )
      mocks.moveSelectedTurnsToNewBranch.mockResolvedValue({
        branch: { id: 'nb', anchorMessageId: 'aA' },
        movedMessageIds: ['uB', 'aB', 'uC', 'aC'],
        anchorMessageId: 'aA',
        messages: [],
        blocks: [],
        resolvedContextAnchorGroupKey: 'uA'
      })
      // User moves to another branch while the commit IPC is in flight.
      const originalImpl = mocks.moveSelectedTurnsToNewBranch.getMockImplementation()
      mocks.moveSelectedTurnsToNewBranch.mockImplementationOnce(() => {
        current = {
          ...current,
          topicBranch: {
            ...current.topicBranch,
            activeBranchIdByTopic: { 't-1': 'b-user' },
            routeGenerationByTopic: { 't-1': 2 }
          }
        }
        return (originalImpl as () => Promise<unknown>)()
      })
      const localDispatch = vi.fn((action: unknown) => {
        if (typeof action === 'function') return Promise.resolve(undefined)
        return action
      })
      const res = (await moveSelectedTurnsToNewBranchThunk(
        't-1',
        null,
        ['uB', 'uC'],
        'Moved'
      )(localDispatch as any, (() => current) as any)) as unknown as { branchId: string } | null
      expect(res?.branchId).toBe('nb')
      const anchorWrites = actionsOfType(localDispatch, 'assistants/updateAssistantSettings')
      expect(anchorWrites).toHaveLength(1)
      const write = anchorWrites[0] as { payload: { settings: { contextWindowAnchor: Record<string, unknown> } } }
      expect(write.payload.settings.contextWindowAnchor['t-1:nb']).toEqual({ kind: 'active', groupKey: 'uA' })
      // No forced navigation back to the moved-to branch.
      expect(actionsOfType(localDispatch, 'topicBranch/activeBranchSet')).toHaveLength(0)
    })

    it('invents no anchor when Main returns no fact (absent)', async () => {
      const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
      mocks.moveSelectedTurnsToNewBranch.mockResolvedValue({
        branch: { id: 'nb', anchorMessageId: 'aA' },
        movedMessageIds: ['uB', 'aB', 'uC', 'aC'],
        anchorMessageId: 'aA',
        messages: [],
        blocks: []
      })
      const state = stateWithOwner(
        { active: null, loaded: LOADED, mutable: LOADED, selected: ['uB', 'uC'], catalog: [] },
        { contextWindowAnchor: {}, contextCount: 25 }
      )
      const localDispatch = vi.fn((action: unknown) => {
        if (typeof action === 'function') return Promise.resolve(undefined)
        return action
      })
      await moveSelectedTurnsToNewBranchThunk(
        't-1',
        null,
        ['uB', 'uC'],
        'Moved'
      )(localDispatch as any, (() => state) as any)
      expect(actionsOfType(localDispatch, 'assistants/updateAssistantSettings')).toHaveLength(0)
    })

    it('applies Main source-anchor transfer and the destination anchor in ONE settings update', async () => {
      const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
      mocks.moveSelectedTurnsToNewBranch.mockResolvedValue({
        branch: { id: 'nb', anchorMessageId: 'aA' },
        movedMessageIds: ['uB', 'aB', 'uC', 'aC'],
        anchorMessageId: 'aA',
        messages: [],
        blocks: [],
        resolvedContextAnchorGroupKey: 'uB',
        sourceContextAnchorTransfer: { fromGroupKey: 'uB', toGroupKey: 'uA' }
      })
      const current = stateWithOwner(
        { active: null, loaded: LOADED, mutable: LOADED, selected: ['uB', 'uC'], catalog: [] },
        { contextWindowAnchor: { 't-1': { kind: 'active', groupKey: 'uB' } }, contextCount: 25 }
      )
      const localDispatch = vi.fn((action: unknown) => {
        if (typeof action === 'function') return Promise.resolve(undefined)
        const type = (action as { type?: string })?.type
        if (type === 'assistants/updateAssistantSettings') {
          const payload = (action as { payload: any }).payload
          current.assistants.assistants[0].settings = {
            ...current.assistants.assistants[0].settings,
            ...payload.settings
          }
        }
        return action
      })
      await moveSelectedTurnsToNewBranchThunk(
        't-1',
        null,
        ['uB', 'uC'],
        'Moved'
      )(localDispatch as any, (() => current) as any)
      const anchorWrites = actionsOfType(localDispatch, 'assistants/updateAssistantSettings')
      // One atomic map update carrying both route keys.
      expect(anchorWrites).toHaveLength(1)
      const map = (anchorWrites[0] as { payload: { settings: { contextWindowAnchor: Record<string, unknown> } } })
        .payload.settings.contextWindowAnchor
      expect(map['t-1']).toEqual({ kind: 'active', groupKey: 'uA' })
      expect(map['t-1:nb']).toEqual({ kind: 'active', groupKey: 'uB' })
    })

    it('does not overwrite a source anchor the user explicitly re-anchored during the commit wait', async () => {
      const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
      const current = stateWithOwner(
        { active: null, loaded: LOADED, mutable: LOADED, selected: ['uB', 'uC'], catalog: [] },
        { contextWindowAnchor: { 't-1': { kind: 'active', groupKey: 'uB' } }, contextCount: 25 }
      )
      mocks.moveSelectedTurnsToNewBranch.mockImplementationOnce(() => {
        // Explicit user re-anchor of the source route while the IPC is in flight.
        current.assistants.assistants[0].settings = {
          ...current.assistants.assistants[0].settings,
          contextWindowAnchor: { 't-1': { kind: 'active', groupKey: 'uD' } }
        }
        return Promise.resolve({
          branch: { id: 'nb', anchorMessageId: 'aA' },
          movedMessageIds: ['uB', 'aB', 'uC', 'aC'],
          anchorMessageId: 'aA',
          messages: [],
          blocks: [],
          resolvedContextAnchorGroupKey: 'uB',
          sourceContextAnchorTransfer: { fromGroupKey: 'uB', toGroupKey: 'uA' }
        })
      })
      const localDispatch = vi.fn((action: unknown) => {
        if (typeof action === 'function') return Promise.resolve(undefined)
        return action
      })
      await moveSelectedTurnsToNewBranchThunk(
        't-1',
        null,
        ['uB', 'uC'],
        'Moved'
      )(localDispatch as any, (() => current) as any)
      const anchorWrites = actionsOfType(localDispatch, 'assistants/updateAssistantSettings')
      // The destination write still happens (no skipping), and the source key is
      // left exactly as the user set it.
      expect(anchorWrites).toHaveLength(1)
      const map = (anchorWrites[0] as { payload: { settings: { contextWindowAnchor: Record<string, unknown> } } })
        .payload.settings.contextWindowAnchor
      expect(map['t-1']).toEqual({ kind: 'active', groupKey: 'uD' })
      expect(map['t-1:nb']).toEqual({ kind: 'active', groupKey: 'uB' })
    })

    it('writes nothing for the source route when Main reports no transfer (anchor survived)', async () => {
      const { moveSelectedTurnsToNewBranchThunk } = await import('../messageThunk')
      mocks.moveSelectedTurnsToNewBranch.mockResolvedValue({
        branch: { id: 'nb', anchorMessageId: 'aA' },
        movedMessageIds: ['uB', 'aB', 'uC', 'aC'],
        anchorMessageId: 'aA',
        messages: [],
        blocks: [],
        resolvedContextAnchorGroupKey: 'uA'
      })
      const current = stateWithOwner(
        { active: null, loaded: LOADED, mutable: LOADED, selected: ['uB', 'uC'], catalog: [] },
        { contextWindowAnchor: { 't-1': { kind: 'active', groupKey: 'uA' } }, contextCount: 25 }
      )
      const localDispatch = vi.fn((action: unknown) => {
        if (typeof action === 'function') return Promise.resolve(undefined)
        const type = (action as { type?: string })?.type
        if (type === 'assistants/updateAssistantSettings') {
          const payload = (action as { payload: any }).payload
          current.assistants.assistants[0].settings = {
            ...current.assistants.assistants[0].settings,
            ...payload.settings
          }
        }
        return action
      })
      await moveSelectedTurnsToNewBranchThunk(
        't-1',
        null,
        ['uB', 'uC'],
        'Moved'
      )(localDispatch as any, (() => current) as any)
      const map = (
        actionsOfType(localDispatch, 'assistants/updateAssistantSettings')[0] as {
          payload: { settings: { contextWindowAnchor: Record<string, unknown> } }
        }
      ).payload.settings.contextWindowAnchor
      expect(map['t-1']).toEqual({ kind: 'active', groupKey: 'uA' })
      expect(map['t-1:nb']).toEqual({ kind: 'active', groupKey: 'uA' })
    })
  })
})
