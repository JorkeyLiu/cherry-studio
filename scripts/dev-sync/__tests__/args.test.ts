import { describe, expect, it } from 'vitest'

import { parseDevSyncArgs } from '../args'
import { DEV_SYNC_DEFAULT_CDP_A, DEV_SYNC_DEFAULT_CDP_B, DEV_SYNC_DEFAULT_RELAY_PORT } from '../constants'

describe('parseDevSyncArgs', () => {
  it('defaults to the fixed fixture ports', () => {
    expect(parseDevSyncArgs([])).toEqual({
      relayPort: DEV_SYNC_DEFAULT_RELAY_PORT,
      cdpA: DEV_SYNC_DEFAULT_CDP_A,
      cdpB: DEV_SYNC_DEFAULT_CDP_B,
      help: false
    })
  })

  it('accepts explicit port overrides', () => {
    const parsed = parseDevSyncArgs(['--relay-port', '3040', '--cdp-a', '9233', '--cdp-b', '9234'])
    expect(parsed).toEqual({ relayPort: 3040, cdpA: 9233, cdpB: 9234, help: false })
  })

  it('accepts --help without starting anything', () => {
    expect(parseDevSyncArgs(['--help']).help).toBe(true)
    expect(parseDevSyncArgs(['-h']).help).toBe(true)
  })

  it('rejects unknown options fail-closed', () => {
    expect(() => parseDevSyncArgs(['--reset'])).toThrow(/unknown option/)
    expect(() => parseDevSyncArgs(['--relay-port'])).toThrow(/missing value/)
    expect(() => parseDevSyncArgs(['--relay-port', '0'])).toThrow(/invalid --relay-port/)
    expect(() => parseDevSyncArgs(['--relay-port', '99999'])).toThrow(/invalid --relay-port/)
    expect(() => parseDevSyncArgs(['--relay-port', 'abc'])).toThrow(/invalid --relay-port/)
  })

  it('rejects identical CDP ports', () => {
    expect(() => parseDevSyncArgs(['--cdp-a', '9300', '--cdp-b', '9300'])).toThrow(/must differ/)
  })
})
