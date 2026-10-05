import { createServer } from 'node:net'

import { describe, expect, it } from 'vitest'

import { assertTcpPortFree, isTcpPortFree } from '../ports'

async function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

describe('isTcpPortFree', () => {
  it('reports free then busy for the same ephemeral port', async () => {
    const port = await ephemeralPort()
    expect(await isTcpPortFree('127.0.0.1', port)).toBe(true)
    const holder = createServer()
    await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', () => resolve()))
    try {
      expect(await isTcpPortFree('127.0.0.1', port)).toBe(false)
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()))
    }
    expect(await isTcpPortFree('127.0.0.1', port)).toBe(true)
  })

  it('assertTcpPortFree fails closed with the override direction', async () => {
    const port = await ephemeralPort()
    await assertTcpPortFree('127.0.0.1', port, 'relay')
    const holder = createServer()
    await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', () => resolve()))
    try {
      await expect(assertTcpPortFree('127.0.0.1', port, 'relay')).rejects.toThrow(/refusing to steal/)
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()))
    }
  })
})
