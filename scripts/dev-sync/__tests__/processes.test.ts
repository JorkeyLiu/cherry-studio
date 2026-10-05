import { describe, expect, it } from 'vitest'

import {
  argvHasExactUserDataDir,
  buildProfileBLaunchArgs,
  cdpEndpointUrl,
  describeCleanup,
  hasSingleExplicitCdpPort,
  selectOwnedProcesses,
  snapshotAllBeforeTeardown,
  userDataDirArg
} from '../processes'

describe('argvHasExactUserDataDir', () => {
  it('matches the exact token only, never a substring', () => {
    const dir = '/repo/local/dev-sync/profile-a'
    expect(argvHasExactUserDataDir(['electron', userDataDirArg(dir)], dir)).toBe(true)
    expect(argvHasExactUserDataDir(['electron', `--user-data-dir=${dir}-evil`], dir)).toBe(false)
    expect(argvHasExactUserDataDir(['electron', '--user-data-dir=/other'], dir)).toBe(false)
    expect(argvHasExactUserDataDir([], dir)).toBe(false)
  })
})

describe('selectOwnedProcesses', () => {
  it('selects only exact-token owners across both profiles', () => {
    const a = '/repo/local/dev-sync/profile-a'
    const b = '/repo/local/dev-sync/profile-b'
    const processes = [
      { pid: 11, argv: ['electron', userDataDirArg(a)] },
      { pid: 12, argv: ['electron', userDataDirArg(b)] },
      { pid: 13, argv: ['electron', `--user-data-dir=${a}-evil`] },
      { pid: 14, argv: ['electron', '--user-data-dir=/Users/someone/CherryChat'] }
    ]
    expect(selectOwnedProcesses(processes, [a, b]).map((p) => p.pid)).toEqual([11, 12])
  })

  it('scopes cleanup to the fresh session dirs: legacy and main profiles are never targets', () => {
    const sessionA = '/repo/local/dev-sync/sessions/sess-1/profile-a'
    const sessionB = '/repo/local/dev-sync/sessions/sess-1/profile-b'
    const legacyA = '/repo/local/dev-sync/profile-a'
    const processes = [
      { pid: 21, argv: ['electron', userDataDirArg(sessionA)] },
      { pid: 22, argv: ['electron', userDataDirArg(sessionB)] },
      { pid: 23, argv: ['electron', userDataDirArg(legacyA)] },
      { pid: 24, argv: ['electron', '--user-data-dir=/Users/someone/Library/Application Support/CherryChat'] }
    ]
    expect(selectOwnedProcesses(processes, [sessionA, sessionB]).map((p) => p.pid)).toEqual([21, 22])
  })
})

describe('describeCleanup', () => {
  it('states stopped children and preserved fixture state without secrets', () => {
    const text = describeCleanup(['relay', 'electron-vite(A)', 'profile-B'], ['profile-a', 'profile-b', 'relay-data'])
    expect(text).toContain('never deleted')
    expect(text).toContain('profile-a')
    expect(text).not.toMatch(/[0-9a-f]{32,}/)
  })
})

describe('buildProfileBLaunchArgs', () => {
  it('carries one explicit =-form CDP port and the exact profile token', () => {
    const dir = '/repo/local/dev-sync/sessions/sess-1/profile-b'
    const args = buildProfileBLaunchArgs(dir, 9224)
    expect(args).toEqual(['.', `--user-data-dir=${dir}`, '--remote-debugging-port=9224'])
    expect(hasSingleExplicitCdpPort(args, 9224)).toBe(true)
  })

  it('honours a custom --cdp-b port', () => {
    const args = buildProfileBLaunchArgs('/repo/local/dev-sync/sessions/sess-2/profile-b', 9234)
    expect(args).toContain('--remote-debugging-port=9234')
    expect(hasSingleExplicitCdpPort(args, 9234)).toBe(true)
    expect(hasSingleExplicitCdpPort(args, 9224)).toBe(false)
  })

  it('rejects the managed-launch auto port and split flag/value shapes', () => {
    const dir = '/repo/local/dev-sync/sessions/sess-1/profile-b'
    expect(hasSingleExplicitCdpPort(['.', `--user-data-dir=${dir}`, '--remote-debugging-port=0'], 9224)).toBe(false)
    expect(
      hasSingleExplicitCdpPort(
        ['--remote-debugging-port=0', '.', `--user-data-dir=${dir}`, '--remote-debugging-port=9224'],
        9224
      )
    ).toBe(false)
    expect(hasSingleExplicitCdpPort(['.', `--user-data-dir=${dir}`, '--remote-debugging-port', '9224'], 9224)).toBe(
      false
    )
    expect(
      hasSingleExplicitCdpPort(
        ['.', `--user-data-dir=${dir}`, '--remote-debugging-port=9224', '--remote-debugging-port=9225'],
        9224
      )
    ).toBe(false)
  })
})

describe('cdpEndpointUrl', () => {
  it('builds the exact loopback endpoint the supervisor probes and logs', () => {
    expect(cdpEndpointUrl(9224)).toBe('http://127.0.0.1:9224')
    expect(cdpEndpointUrl(9234)).toBe('http://127.0.0.1:9234')
  })
})

describe('snapshotAllBeforeTeardown', () => {
  it('snapshots every profile before any teardown step, even when a snapshot fails', async () => {
    const order: string[] = []
    const snapshots = [
      async (): Promise<void> => {
        order.push('snapshot-A')
      },
      async (): Promise<void> => {
        order.push('snapshot-B')
        throw new Error('snapshot B failed')
      }
    ]
    const teardown = [
      async (): Promise<void> => {
        order.push('detach-B')
      },
      async (): Promise<void> => {
        order.push('sigterm-children')
      }
    ]
    await snapshotAllBeforeTeardown(snapshots, teardown)
    expect(order).toEqual(['snapshot-A', 'snapshot-B', 'detach-B', 'sigterm-children'])
  })

  it('runs later teardown steps even when an early one fails', async () => {
    const order: string[] = []
    await snapshotAllBeforeTeardown(
      [
        async (): Promise<void> => {
          order.push('snapshot-A')
        }
      ],
      [
        async (): Promise<void> => {
          order.push('detach-B')
          throw new Error('detach failed')
        },
        async (): Promise<void> => {
          order.push('sigterm-children')
        }
      ]
    )
    expect(order).toEqual(['snapshot-A', 'detach-B', 'sigterm-children'])
  })
})
