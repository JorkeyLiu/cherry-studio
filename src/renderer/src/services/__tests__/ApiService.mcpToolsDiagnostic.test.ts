/**
 * Focused tests for ApiService.fetchMcpTools diagnostic truthfulness.
 *
 * The renderer→main MCP list-tools cold-path diagnostic must reflect settled
 * per-server failures: partial/all failures set `ok:false` with a safe
 * `failedCount`, while the pre-existing returned tools and swallowed
 * per-server error behavior are preserved exactly (LOCK-001/002/003).
 */

import { combineReducers, configureStore } from '@reduxjs/toolkit'
import { messageBlocksSlice } from '@renderer/store/messageBlock'
import type { Assistant, MCPServer, MCPTool } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const reducer = combineReducers({
  messageBlocks: messageBlocksSlice.reducer
})

const createMockStore = () =>
  configureStore({
    reducer,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware({ serializableCheck: false })
  })

let mockStore: ReturnType<typeof createMockStore>

vi.mock('@renderer/store', () => ({
  default: {
    getState: () => mockStore.getState(),
    dispatch: (action: unknown) => mockStore.dispatch(action as never)
  }
}))

vi.mock('@renderer/store/mcp', () => ({
  hubMCPServer: { id: 'hub', type: 'inMemory', name: '@cherry/hub', isActive: true }
}))

vi.mock('@renderer/i18n', () => ({
  default: { t: (key: string) => key }
}))

vi.mock('@renderer/config/models', () => ({
  isDedicatedImageGenerationModel: vi.fn(() => false),
  isEmbeddingModel: vi.fn(() => false),
  isFunctionCallingModel: vi.fn(() => false)
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  getStoreSetting: vi.fn()
}))

vi.mock('@renderer/aiCore/prepareParams', () => ({
  buildStreamTextParams: vi.fn()
}))

vi.mock('@renderer/aiCore/utils/options', () => ({
  buildProviderOptions: vi.fn()
}))

vi.mock('@renderer/aiCore', () => ({
  AiProvider: class MockAiProvider {}
}))

vi.mock('@renderer/services/AssistantService', () => ({
  getDefaultAssistant: vi.fn(),
  getDefaultModel: vi.fn(),
  getProviderByModel: vi.fn(),
  getQuickModel: vi.fn()
}))

vi.mock('@renderer/services/ConversationService', () => ({
  ConversationService: { prepareMessagesForModel: vi.fn() }
}))

vi.mock('@renderer/services/KnowledgeService', () => ({
  injectUserMessageWithKnowledgeSearchPrompt: vi.fn()
}))

vi.mock('@renderer/services/ProviderService', () => ({
  getProviderById: vi.fn()
}))

// Capture the renderer→main MCP discovery diagnostic instead of emitting it.
const { mockLogColdPathDiagnostic } = vi.hoisted(() => ({
  mockLogColdPathDiagnostic: vi.fn()
}))

vi.mock('@renderer/services/db/sendTimingDiagnostics', () => ({
  logColdPathDiagnostic: mockLogColdPathDiagnostic
}))

const { mockListTools } = vi.hoisted(() => ({
  mockListTools: vi.fn()
}))

import { fetchMcpTools } from '../ApiService'

const serverA = { id: 'srv-a', name: 'Server A', isActive: true }
const serverB = { id: 'srv-b', name: 'Server B', isActive: true }

const assistant = {
  id: 'asst-1',
  mcpMode: 'manual',
  mcpServers: [{ id: 'srv-a' }, { id: 'srv-b' }]
} as Assistant

const toolA = { name: 'tool-a' } as MCPTool

beforeEach(() => {
  mockStore = createMockStore()
  vi.clearAllMocks()
  ;(mockStore.getState() as unknown as { mcp: { servers: MCPServer[] } }).mcp = { servers: [serverA, serverB] }
  ;(window as { api?: unknown }).api = { mcp: { listTools: mockListTools } }
})

describe('fetchMcpTools diagnostic truthfulness', () => {
  it('reports ok:true with failedCount:0 when every server settles fulfilled', async () => {
    mockListTools.mockImplementation(async (server: { id: string }) => (server.id === 'srv-a' ? [toolA] : []))

    const tools = await fetchMcpTools(assistant)

    expect(tools).toEqual([toolA])
    const diagCall = mockLogColdPathDiagnostic.mock.calls.find(([stage]) => stage === 'renderer.mcp.listTools')!
    expect(diagCall).toBeDefined()
    const data = diagCall[2] as Record<string, unknown>
    expect(data).toMatchObject({ serverCount: 2, toolCount: 1, failedCount: 0, ok: true })
  })

  it('reports ok:false with failedCount:1 on partial failure and still returns fulfilled tools', async () => {
    mockListTools.mockImplementation(async (server: { id: string }) => {
      if (server.id === 'srv-b') {
        throw new Error('server-b-down')
      }
      return [toolA]
    })

    const tools = await fetchMcpTools(assistant)

    // Pre-existing behavior preserved: tools from the successful server are
    // still returned, the failed server contributes none, and no error
    // propagates to the caller.
    expect(tools).toEqual([toolA])
    const diagCall = mockLogColdPathDiagnostic.mock.calls.find(([stage]) => stage === 'renderer.mcp.listTools')!
    expect(diagCall).toBeDefined()
    const data = diagCall[2] as Record<string, unknown>
    expect(data).toMatchObject({ serverCount: 2, toolCount: 1, failedCount: 1, ok: false })
  })

  it('reports ok:false with failedCount equal to server count on total failure', async () => {
    mockListTools.mockRejectedValue(new Error('all-servers-down'))

    const tools = await fetchMcpTools(assistant)

    expect(tools).toEqual([])
    const diagCall = mockLogColdPathDiagnostic.mock.calls.find(([stage]) => stage === 'renderer.mcp.listTools')!
    expect(diagCall).toBeDefined()
    const data = diagCall[2] as Record<string, unknown>
    expect(data).toMatchObject({ serverCount: 2, toolCount: 0, failedCount: 2, ok: false })
  })
})
