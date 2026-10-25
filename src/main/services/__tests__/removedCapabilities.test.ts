/**
 * Removal regression: MCP / global-Memory / SearchWindow background capabilities + OCR.
 *
 * After full removal of the runnable MCP (MCPService, mcp/*, mcpServers/*,
 * DXT install/upload, mcp API routes, mcp/install protocol), global Memory
 * (memory/*), hidden SearchWindow (SearchService) main-process chains, and the
 * user-authorized full OCR removal (main/services/ocr/*, main/utils/ocr,
 * ocr: IPC + preload surface):
 *  1. No IPC channel value may expose the removed `mcp:` / `memory:` /
 *     `search-window:` / `ocr:` surfaces, while the generic `python:execute`
 *     channel and the ordinary chat/knowledge channels stay intact.
 *  2. The `cherrychat://mcp/install` deep link must no longer push an
 *     `mcp:add-server` payload into the renderer.
 *  3. The generated OpenAPI spec must not document `/v1/mcps*` endpoints.
 */

import { IpcChannel } from '@shared/IpcChannel'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import openapiSpec from '../../apiServer/generated/openapi-spec.json'

const sendSpy = vi.fn()
const mockMainWindow = {
  isDestroyed: vi.fn(() => false),
  webContents: { send: sendSpy }
}

vi.mock('@main/services/WindowService', () => ({
  windowService: {
    getMainWindow: vi.fn(() => mockMainWindow),
    showMainWindow: vi.fn()
  }
}))

import { handleProtocolUrl } from '@main/services/ProtocolClient'

describe('removed background capabilities stay unexposed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('exposes no mcp:/memory:/search-window: IPC channel', () => {
    const values = Object.values(IpcChannel) as string[]
    expect(values.filter((v) => v.startsWith('mcp:'))).toEqual([])
    expect(values.filter((v) => v.startsWith('memory:'))).toEqual([])
    expect(values.filter((v) => v.startsWith('search-window:'))).toEqual([])
  })

  it('exposes no ocr: IPC channel (full OCR removal)', () => {
    const values = Object.values(IpcChannel) as string[]
    expect(values.filter((v) => v.startsWith('ocr:'))).toEqual([])
    expect((IpcChannel as Record<string, string>).OCR_ocr).toBeUndefined()
    expect((IpcChannel as Record<string, string>).OCR_ListProviders).toBeUndefined()
  })

  it('retains the generic python channel and ordinary chat/knowledge lifecycle channels', () => {
    expect(IpcChannel.Python_Execute).toBe('python:execute')
    expect(IpcChannel.KnowledgeBase_Search).toBe('knowledge-base:search')
    expect(IpcChannel.ChatDb_AppendMessage).toBe('chatdb:append-message')
    expect(IpcChannel.ChatDb_FetchMessages).toBe('chatdb:fetch-messages')
  })

  it('mcp/install deep link no longer injects an add-server payload', () => {
    const servers = Buffer.from(JSON.stringify({ mcpServers: {} })).toString('base64')
    handleProtocolUrl(`cherrychat://mcp/install?servers=${servers}`)
    const sentChannels = sendSpy.mock.calls.map((call) => call[0] as string)
    expect(sentChannels).not.toContain('mcp:add-server')
  })

  it('generated OpenAPI spec documents no /v1/mcps endpoints', () => {
    const paths = Object.keys((openapiSpec as { paths: Record<string, unknown> }).paths ?? {})
    expect(paths.filter((p) => p.startsWith('/v1/mcps'))).toEqual([])
  })
})
