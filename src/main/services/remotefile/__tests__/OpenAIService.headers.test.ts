import type { Provider } from '@types'
import type * as fs from 'fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({
  createArgs: [] as Array<any>,
  listArgs: [] as Array<any>,
  deleteArgs: [] as Array<any>,
  retrieveArgs: [] as Array<any>
}))

vi.mock('@cherrystudio/openai', () => ({
  default: class MockOpenAI {
    files = {
      create: vi.fn(async (...args: any[]) => {
        captured.createArgs.push(args)
        return { id: 'remote-1', filename: 'a.txt', bytes: 1 }
      }),
      list: vi.fn(async (...args: any[]) => {
        captured.listArgs.push(args)
        return { data: [] }
      }),
      delete: vi.fn(async (...args: any[]) => {
        captured.deleteArgs.push(args)
        return {}
      }),
      retrieve: vi.fn(async (...args: any[]) => {
        captured.retrieveArgs.push(args)
        return { id: 'remote-1', filename: 'a.txt' }
      })
    }
    constructor(_opts: any) {}
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })
  }
}))

vi.mock('@main/services/FileStorage', () => ({
  fileStorage: { getFilePathById: vi.fn(() => '/mock/file.txt') }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    createReadStream: vi.fn(() => ({ destroy: vi.fn() }))
  }
})

import { OpenaiService } from '../OpenAIService'

function makeProvider(overrides: Record<string, unknown> = {}): Provider {
  return {
    id: 'conn-1',
    type: 'openai',
    name: 'My Connection',
    apiKey: 'sk-fake-key',
    apiHost: 'https://api.example.com/v1',
    models: [],
    ...overrides
  } as unknown as Provider
}

const fileMeta = { id: 'f1', origin_name: 'a.txt' } as never

describe('OpenAIService shared header policy (per-request file headers)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    captured.createArgs.length = 0
    captured.listArgs.length = 0
    captured.deleteArgs.length = 0
    captured.retrieveArgs.length = 0
  })

  it('sends no session header on non-Go endpoints (no fabricated options)', async () => {
    const service = new OpenaiService(makeProvider())
    await service.listFiles()
    await service.retrieveFile('f1')

    expect(captured.listArgs[0]).toHaveLength(0)
    expect(captured.retrieveArgs[0]).toHaveLength(1)
  })

  it('mints a topicless opaque Go session per file invocation', async () => {
    const service = new OpenaiService(makeProvider({ apiHost: 'https://opencode.ai/zen/go/v1' }))
    await service.uploadFile(fileMeta)
    await service.listFiles()

    const uploadOptions = captured.createArgs[0][1] as { headers: Record<string, string> }
    const listOptions = captured.listArgs[0][1] as { headers: Record<string, string> }
    expect(uploadOptions.headers['x-opencode-session']).toBeTruthy()
    expect(listOptions.headers['x-opencode-session']).toBeTruthy()
    // Upload body untouched: purpose default preserved.
    expect(captured.createArgs[0][0]).toMatchObject({ purpose: 'assistants' })
  })

  it('forwards provider custom headers with a provider extra session winning', async () => {
    const service = new OpenaiService(
      makeProvider({
        apiHost: 'https://opencode.ai/zen/go/v1',
        extra_headers: { 'X-Custom': 'keep', 'x-opencode-session': 'provider-extra' }
      })
    )
    await service.deleteFile('f1')

    const options = captured.deleteArgs[0][1] as { headers: Record<string, string> }
    expect(options.headers['X-Custom']).toBe('keep')
    expect(options.headers['x-opencode-session']).toBe('provider-extra')
  })
})
