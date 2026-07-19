import type { Message } from '@renderer/types/newMessage'
import { describe, expect, it } from 'vitest'

import { getBranchEndpoint } from '../messageBranch'

describe('getBranchEndpoint', () => {
  it('uses the message id to locate a branch endpoint in the full chronological history', () => {
    const messages = ['m0', 'm1', 'm2', 'm3', 'm4'].map((id) => ({ id }) as Message)

    expect(getBranchEndpoint(messages, 'm2')).toBe(3)
    expect(getBranchEndpoint(messages, 'missing')).toBeNull()
  })
})
