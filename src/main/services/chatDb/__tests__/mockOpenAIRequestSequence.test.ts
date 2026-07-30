import { describe, expect, it } from 'vitest'

import { createMonotonicRequestLog } from '../../../test-utils/monotonicRequestLog'

describe('mock request sequencing', () => {
  it('keeps sequences monotonic and includes the first request after a clear', () => {
    const requestLog = createMonotonicRequestLog<{ request: string }>()
    const before = requestLog.getSequence()

    requestLog.append({ request: 'first' })
    const first = requestLog.getEntries()[0]

    requestLog.clear()
    const operationStart = requestLog.getSequence()
    requestLog.append({ request: 'second' })

    const second = requestLog.getEntries().find((entry) => entry.sequence >= operationStart)
    expect(first.sequence).toBeGreaterThanOrEqual(before)
    expect(second?.sequence).toBe(operationStart)
    expect(second?.request).toBe('second')
  })
})
