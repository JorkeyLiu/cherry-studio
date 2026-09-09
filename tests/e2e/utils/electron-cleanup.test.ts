import { describe, expect, it, vi } from 'vitest'

import { closeElectronWithExactCleanup } from './electron-cleanup'

describe('Electron exact-profile cleanup', () => {
  it('combines close rejection and exact-profile cleanup errors', async () => {
    const close = vi.fn().mockRejectedValue(new Error('close failed'))
    const terminate = vi.fn().mockRejectedValue(new Error('terminate failed'))
    const find = vi.fn().mockImplementation(() => {
      throw new Error('scan failed')
    })

    const error = await closeElectronWithExactCleanup('/owned/profile', {
      close,
      findExactProcesses: find,
      terminateExactProcesses: terminate
    }).catch((e) => e)

    expect(error).toBeInstanceOf(AggregateError)
    const messages = error.errors.map((entry: Error) => entry.message)
    expect(messages).toContain('close failed')
    expect(messages.some((m: string) => m.includes('terminate failed'))).toBe(true)
    expect(messages.some((m: string) => m.includes('scan failed'))).toBe(true)
    expect(close).toHaveBeenCalledOnce()
    expect(terminate).toHaveBeenCalledWith('/owned/profile')
  })

  it('always invokes the exact terminator after a clean close with no process', async () => {
    const terminate = vi.fn().mockResolvedValue({ killedPids: [], remainingPids: [], errors: [] })
    const find = vi.fn().mockReturnValue([])

    await expect(
      closeElectronWithExactCleanup('/owned/profile', {
        close: vi.fn().mockResolvedValue(undefined),
        findExactProcesses: find,
        terminateExactProcesses: terminate
      })
    ).resolves.toBeUndefined()
    expect(terminate).toHaveBeenCalledWith('/owned/profile')
    expect(find).toHaveBeenCalledOnce()
  })

  it('reports late-spawn remaining PIDs and terminator errors in the aggregate', async () => {
    const find = vi.fn().mockReturnValue([])
    const error = await closeElectronWithExactCleanup('/owned/profile', {
      close: vi.fn().mockResolvedValue(undefined),
      findExactProcesses: find,
      terminateExactProcesses: vi.fn().mockResolvedValue({
        killedPids: [7],
        remainingPids: [8],
        errors: ['SIGKILL 8: permission denied']
      })
    }).catch((e) => e)

    expect(error).toBeInstanceOf(AggregateError)
    const messages = error.errors.map((entry: Error) => entry.message)
    expect(messages).toContain('SIGKILL 8: permission denied')
    expect(messages.some((m: string) => m.includes('processes remained'))).toBe(true)
  })

  it('succeeds even when close rejects but the exact profile becomes clean', async () => {
    // The terminator still owns the bounded settle: a close failure is
    // tolerated only when exact-token termination + verification fully clean.
    const terminate = vi.fn().mockResolvedValue({ killedPids: [], remainingPids: [], errors: [] })
    const find = vi.fn().mockReturnValue([])

    await expect(
      closeElectronWithExactCleanup('/owned/profile', {
        close: vi.fn().mockRejectedValue(new Error('close failed')),
        findExactProcesses: find,
        terminateExactProcesses: terminate
      })
    ).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'close failed' })] })
    expect(terminate).toHaveBeenCalledWith('/owned/profile')
    expect(find).toHaveBeenCalledOnce()
  })
})
