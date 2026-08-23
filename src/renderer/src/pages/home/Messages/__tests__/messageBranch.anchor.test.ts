import { describe, expect, it, vi } from 'vitest'

import { branchFromAnchorMessage, branchFromMessage, getBranchEndpoint } from '../messageBranch'

describe('messageBranch S6.2c-1 anchor invariants', () => {
  const msgs = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] as any

  it('getBranchEndpoint still exists for legacy but new path must not expose index', async () => {
    expect(getBranchEndpoint(msgs, 'm2')).toBe(2)
    // Ensure new anchor helper exists and does not compute numeric endpoint externally
    expect(typeof branchFromAnchorMessage).toBe('function')
  })

  it('branchFromAnchorMessage does not slice/index, calls createBranchByAnchor with anchor id', async () => {
    const createBranchByAnchor = vi.fn(async () => true)
    const onSuccess = vi.fn()
    const onFailure = vi.fn()
    const onMessageNotFound = vi.fn()

    const ok = await branchFromAnchorMessage(msgs, 'm2', {
      createBranchByAnchor,
      onSuccess,
      onFailure,
      onMessageNotFound
    })

    expect(ok).toBe(true)
    expect(createBranchByAnchor).toHaveBeenCalledWith('m2')
    expect(createBranchByAnchor).toHaveBeenCalledOnce()
    expect(onSuccess).toHaveBeenCalledOnce()
    // Validate implementation does not call getBranchEndpoint internally (no index arithmetic)
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('src/renderer/src/pages/home/Messages/messageBranch.ts', 'utf8')
    )
    const anchorSegment = source.slice(source.indexOf('export const branchFromAnchorMessage'))
    expect(anchorSegment).not.toMatch(/getBranchEndpoint/)
    expect(anchorSegment).not.toMatch(/branchEndpoint/)
    expect(anchorSegment).not.toMatch(/\.slice/)
  })

  it('branchFromAnchorMessage succeeds even when anchor outside window (no window gating)', async () => {
    const outsideMsgs = [{ id: 'm1' }] as any // window does not contain m999
    const createBranchByAnchor = vi.fn(async () => true)
    const onSuccess = vi.fn()
    const onFailure = vi.fn()
    const onMessageNotFound = vi.fn()

    const ok = await branchFromAnchorMessage(outsideMsgs, 'm-outside-window', {
      createBranchByAnchor,
      onSuccess,
      onFailure,
      onMessageNotFound
    })

    // Must still attempt Main call, not early not-found based on window
    expect(createBranchByAnchor).toHaveBeenCalledWith('m-outside-window')
    expect(onMessageNotFound).not.toHaveBeenCalled()
    expect(onSuccess).toHaveBeenCalled()
    expect(ok).toBe(true)
  })

  it('legacy branchFromMessage still validates missing id via endpoint null', async () => {
    const createBranch = vi.fn()
    const onMessageNotFound = vi.fn()
    const ok = await branchFromMessage(msgs, 'missing', {
      createBranch,
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      onMessageNotFound
    })
    expect(ok).toBe(false)
    expect(onMessageNotFound).toHaveBeenCalledOnce()
    expect(createBranch).not.toHaveBeenCalled()
  })
})
