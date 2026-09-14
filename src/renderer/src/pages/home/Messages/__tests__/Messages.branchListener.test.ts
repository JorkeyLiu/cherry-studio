import * as fs from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('Messages NEW_BRANCH primary listener — S6.2c-1', () => {
  const source = fs.readFileSync('src/renderer/src/pages/home/Messages/Messages.tsx', 'utf8')
  const hookSource = fs.readFileSync('src/renderer/src/hooks/useMessageOperations.ts', 'utf8')
  const thunkSource = fs.readFileSync('src/renderer/src/store/thunk/messageThunk.ts', 'utf8')

  it('primary listener imports branchFromAnchorMessage, not legacy branchFromMessage alone', () => {
    expect(source).toMatch(/branchFromAnchorMessage/)
    // Legacy import should not be the primary (if still present for compat, it should not be used in NEW_BRANCH handler)
    // Ensure NEW_BRANCH handler near branchFromAnchorMessage uses createTopicBranchByAnchor
    const newBranchIdx = source.indexOf('EVENT_NAMES.NEW_BRANCH')
    const handlerSlice = source.slice(newBranchIdx, newBranchIdx + 2000)
    expect(handlerSlice).toMatch(/branchFromAnchorMessage/)
    expect(handlerSlice).toMatch(/createTopicBranchByAnchor/)
    expect(handlerSlice).not.toMatch(/createTopicBranch\(topic\.id, branchEndpoint/)
  })

  it('hook exposes createTopicBranchByAnchor primary; index-based dead branch removed', () => {
    expect(hookSource).toMatch(/createTopicBranchByAnchor/)
    expect(hookSource).toMatch(/branchMessagesToTopicThunk/)
    // Dead renderer branch (index/slice clone) removed; the anchor name contains
    // the `createTopicBranch` prefix, so match the legacy call signature instead.
    expect(hookSource).not.toMatch(/cloneMessagesToNewTopicThunk/)
    expect(hookSource).not.toMatch(/branchPointIndex/)
  })

  it('thunk primary path does not compute branchPointIndex/slice from partial projection', () => {
    const start = thunkSource.indexOf('export const branchMessagesToTopicThunk')
    // Limit to the new thunk body (first 2000 chars) to exclude the following legacy thunk's JSDoc
    const anchorSegment = thunkSource.slice(start, start + 2000)
    expect(anchorSegment).not.toMatch(/branchPointIndex/)
    expect(anchorSegment).not.toMatch(/\.slice\(0, branchPointIndex/)
    expect(anchorSegment).toMatch(/branchMessagesToTopic/)
    expect(anchorSegment).toMatch(/anchorMessageId/)
  })

  it('dead index-based clone thunk removed; NEW_BRANCH primary handler never used it', () => {
    // Dead renderer branch removed (Main/IPC `cloneMessagesToTopic` compat untouched).
    expect(thunkSource).not.toMatch(/export const cloneMessagesToNewTopicThunk/)
    // But NEW_BRANCH handler must not use it
    const newBranchHandler = source.slice(
      source.indexOf('EVENT_NAMES.NEW_BRANCH'),
      source.indexOf('EVENT_NAMES.NEW_BRANCH') + 2000
    )
    expect(newBranchHandler).not.toMatch(/cloneMessagesToNewTopicThunk/)
  })

  it('context-window inheritance and navigation semantics preserved', () => {
    // Inheritance code must remain after branch success
    const newBranchIdx = source.indexOf('EVENT_NAMES.NEW_BRANCH')
    const segment = source.slice(newBranchIdx, newBranchIdx + 5000)
    expect(segment).toMatch(/inheritAnchorForBranch/)
    expect(segment).toMatch(/ensureTopicAnchorEstablished/)
    expect(segment).toMatch(/setActiveTopic/)
  })
})
