/**
 * Startup recovery seam tests (app-ready lifecycle wiring).
 *
 * Verifies the exact behavior src/main/index.ts relies on:
 * - Both recoveries are invoked on startup (temp workspaces first, then
 *   candidates — preserved original order, LOCK-L1).
 * - A failure in either recovery is contained and logged, never thrown,
 *   and does not prevent the other recovery from running (LOCK-L3).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const recoverOrphanedTempWorkspacesMock = vi.fn()
const recoverOrphanedCandidatesMock = vi.fn()

vi.mock('../tempWorkspace', () => ({
  recoverOrphanedTempWorkspaces: (...args: unknown[]) => recoverOrphanedTempWorkspacesMock(...args)
}))

vi.mock('../candidateDb', () => ({
  recoverOrphanedCandidates: (...args: unknown[]) => recoverOrphanedCandidatesMock(...args)
}))

import { loggerService } from '@logger'

import { recoverOrphanedImportArtifacts } from '../startupRecovery'

describe('recoverOrphanedImportArtifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    recoverOrphanedTempWorkspacesMock.mockResolvedValue(undefined)
    recoverOrphanedCandidatesMock.mockResolvedValue(undefined)
  })

  it('invokes temp-workspace recovery then candidate recovery on startup', async () => {
    await recoverOrphanedImportArtifacts()

    expect(recoverOrphanedTempWorkspacesMock).toHaveBeenCalledTimes(1)
    expect(recoverOrphanedCandidatesMock).toHaveBeenCalledTimes(1)

    // Preserved original startup order: temp workspaces before candidates.
    const tempOrder = recoverOrphanedTempWorkspacesMock.mock.invocationCallOrder[0]
    const candidateOrder = recoverOrphanedCandidatesMock.mock.invocationCallOrder[0]
    expect(tempOrder).toBeLessThan(candidateOrder)
  })

  it('calls candidate recovery with no arguments (uses owned default data root)', async () => {
    await recoverOrphanedImportArtifacts()

    expect(recoverOrphanedCandidatesMock).toHaveBeenCalledWith()
  })

  it('contains and logs a temp-workspace recovery failure, still runs candidate recovery', async () => {
    const warnSpy = vi.spyOn(loggerService, 'warn').mockImplementation(() => undefined)
    recoverOrphanedTempWorkspacesMock.mockRejectedValue(new Error('temp recovery failed'))

    await expect(recoverOrphanedImportArtifacts()).resolves.toBeUndefined()

    expect(recoverOrphanedCandidatesMock).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith('Failed to recover orphaned import workspaces (non-fatal):', expect.any(Error))
    warnSpy.mockRestore()
  })

  it('contains and logs a candidate recovery failure without throwing', async () => {
    const warnSpy = vi.spyOn(loggerService, 'warn').mockImplementation(() => undefined)
    recoverOrphanedCandidatesMock.mockRejectedValue(new Error('candidate recovery failed'))

    await expect(recoverOrphanedImportArtifacts()).resolves.toBeUndefined()

    expect(recoverOrphanedTempWorkspacesMock).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to recover orphaned candidate databases (non-fatal):',
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })

  it('contains both failures independently (no cascade, no throw)', async () => {
    const warnSpy = vi.spyOn(loggerService, 'warn').mockImplementation(() => undefined)
    recoverOrphanedTempWorkspacesMock.mockRejectedValue(new Error('temp failed'))
    recoverOrphanedCandidatesMock.mockRejectedValue(new Error('candidate failed'))

    await expect(recoverOrphanedImportArtifacts()).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalledTimes(2)
    warnSpy.mockRestore()
  })
})
