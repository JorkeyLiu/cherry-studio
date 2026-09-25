import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('Messages NEW_TRUE_BRANCH listener (internal branch creation)', () => {
  const source = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
  const hookSource = fs.readFileSync('src/renderer/src/hooks/useMessageOperations.ts', 'utf8')
  const thunkSource = fs.readFileSync('src/renderer/src/store/thunk/messageThunk.ts', 'utf8')

  it('registers a dedicated NEW_TRUE_BRANCH listener separate from legacy NEW_BRANCH', () => {
    expect(source).toMatch(/EVENT_NAMES\.NEW_TRUE_BRANCH/)
    const legacyIdx = source.indexOf('EVENT_NAMES.NEW_BRANCH')
    const trueIdx = source.indexOf('EVENT_NAMES.NEW_TRUE_BRANCH')
    expect(legacyIdx).toBeGreaterThanOrEqual(0)
    expect(trueIdx).toBeGreaterThanOrEqual(0)
    expect(trueIdx).not.toBe(legacyIdx)
  })

  it('true-branch path creates via createBranch with the localized default name and no auto-rename', () => {
    const trueIdx = source.indexOf('EVENT_NAMES.NEW_TRUE_BRANCH')
    const handlerSlice = source.slice(trueIdx, trueIdx + 2500)
    expect(handlerSlice).toMatch(/createBranch/)
    expect(handlerSlice).toMatch(/branchFromAnchorMessage/)
    expect(handlerSlice).toMatch(/chat\.topics\.branch\.default_name/)
    expect(handlerSlice).toMatch(/chat\.message\.true_branch\.created/)
    expect(handlerSlice).not.toMatch(/autoRenameTopic/)
    expect(handlerSlice).not.toMatch(/branchMessagesToTopicThunk/)
  })

  it('hook exposes createBranch backed by createBranchThunk (no prefix clone, no topics)', () => {
    expect(hookSource).toMatch(/createBranchThunk/)
    const thunkStart = thunkSource.indexOf('export const createBranchThunk')
    expect(thunkStart).toBeGreaterThanOrEqual(0)
    const thunkSlice = thunkSource.slice(thunkStart, thunkStart + 2500)
    expect(thunkSlice).toMatch(/dbService\.createBranch/)
    expect(thunkSlice).not.toMatch(/addTopic/)
    expect(thunkSlice).not.toMatch(/setActiveTopic/)
  })

  it('creating a branch selects the route and loads it (never a topic transition)', () => {
    const trueIdx = source.indexOf('EVENT_NAMES.NEW_TRUE_BRANCH')
    const handlerSlice = source.slice(trueIdx, trueIdx + 2500)
    expect(handlerSlice).toMatch(/activeBranchSet/)
    expect(handlerSlice).toMatch(/loadRouteMessagesThunk/)
    expect(handlerSlice).not.toMatch(/setActiveTopic/)
  })

  it('divider route switch preserves the visual reference (never pending navigate, never bottom)', () => {
    const switchIdx = source.indexOf('handleSelectRoute')
    expect(switchIdx).toBeGreaterThanOrEqual(0)
    const switchSlice = source.slice(switchIdx, switchIdx + 6000)
    expect(switchSlice).toMatch(/savePosition/)
    expect(switchSlice).toMatch(/findFirstVisibleMessage/)
    expect(switchSlice).toMatch(/visualOffset|visual-anchor/)
    expect(switchSlice).not.toMatch(/setPendingAnchorNavigate/)
    expect(switchSlice).not.toMatch(/NAVIGATE_TO_MESSAGE/)
    expect(switchSlice).not.toMatch(/setActiveTopic/)
  })
})
