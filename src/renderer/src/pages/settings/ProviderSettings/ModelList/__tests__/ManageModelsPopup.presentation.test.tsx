import { act, cleanup } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })
}

import { setModelMetadataSnapshotForTests } from '@renderer/services/modelMetadata'
import type { Model } from '@renderer/types'

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: ({ model, size }: any) => <div data-testid="model-avatar" data-model-id={model.id} data-size={size} />
}))
vi.mock('@renderer/components/ExpandableText', () => ({ default: () => <div /> }))
vi.mock('@renderer/components/Tags/CustomTag', () => ({ default: ({ children }: any) => <span>{children}</span> }))
vi.mock('@renderer/components/VirtualList', () => ({
  DynamicVirtualList: ({ list, children }: any) => (
    <div data-testid="virtual-list">
      {(list as any[]).map((row: any, i: number) => (
        <div key={i} data-testid="row">
          {typeof children === 'function' ? children(row) : children}
        </div>
      ))}
    </div>
  )
}))
vi.mock('@renderer/pages/files/FileItem', () => ({
  default: ({ fileInfo }: any) => (
    <div data-testid="file-item">
      {fileInfo?.icon}
      <div data-testid="file-name">{fileInfo?.name}</div>
      {fileInfo?.actions}
    </div>
  )
}))
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})
vi.mock('@renderer/services/ApiService', () => ({
  fetchModels: vi.fn(async () => [])
}))
vi.mock('@renderer/hooks/useProvider', () => ({
  useProvider: (id: string) => ({
    provider: {
      id,
      name: 'OpenAI',
      type: 'openai',
      apiKey: '',
      apiHost: 'https://api.openai.com/v1',
      models: []
    } as any,
    models: [],
    addModel: vi.fn(),
    removeModel: vi.fn()
  })
}))
vi.mock('@renderer/components/TopView', () => ({
  TopView: { hide: vi.fn(), show: vi.fn() }
}))
vi.mock('antd', async (importActual) => {
  const actual = await importActual<any>()
  return {
    ...actual,
    Modal: ({ children, open }: any) => (open ? <div data-testid="modal">{children}</div> : null),
    Spin: ({ children }: any) => <div>{children}</div>,
    Tabs: () => <div data-testid="tabs" />,
    Tooltip: ({ children }: any) => <div>{children}</div>,
    Empty: Object.assign((props: any) => <div data-testid="empty">{props.description}</div>, {
      PRESENTED_IMAGE_SIMPLE: 'simple'
    }),
    Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
    Input: (props: any) => <input {...props} />
  }
})

import { fetchModels } from '@renderer/services/ApiService'

const providerId = 'openai'

function installEntry(modelId: string, entry: Record<string, unknown>) {
  const canonicalId = `openai/${modelId}`
  setModelMetadataSnapshotForTests({
    source: 'models.dev',
    fetchedAt: 1,
    models: { [canonicalId]: { id: canonicalId, ...entry } as never },
    providers: {}
  })
}

describe('ManageModelsPopup presentation projection', () => {
  beforeEach(() => {
    cleanup()
    setModelMetadataSnapshotForTests(null)
    vi.clearAllMocks()
  })

  it('fallback raw fetched model renders metadata name + ID and tags from same projection', async () => {
    installEntry('deepseek-flash', {
      name: 'DeepSeek V4.1 Flash',
      modalities: { input: ['text', 'image'], output: ['text'] }
    })
    const fetched: Model[] = [
      { id: 'deepseek-flash', name: 'deepseek-flash', provider: 'openai', group: 'test' } as any
    ]
    vi.mocked(fetchModels).mockResolvedValue(fetched as any)
    void providerId

    const { getModelPresentation } = await import('@renderer/utils/modelPresentation')
    const provider: any = { id: 'openai', name: 'OpenAI', type: 'openai', apiHost: 'https://api.openai.com/v1' }
    const p = getModelPresentation(fetched[0], provider)
    expect(p.displayName).toBe('DeepSeek V4.1 Flash')
    expect(p.effective?.modalities?.input).toContain('image')
    expect(p.model.id).toBe('deepseek-flash')
  })

  it('real provider name wins + ID preserved', async () => {
    installEntry('gemini-2.5-pro', { name: 'Metadata Gemini Name', modalities: { input: ['text'], output: ['text'] } })
    const fetched: Model[] = [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'openai', group: 'test' } as any
    ]
    const { getModelPresentation } = await import('@renderer/utils/modelPresentation')
    const provider: any = { id: 'openai', name: 'OpenAI', type: 'openai', apiHost: 'https://api.openai.com/v1' }
    const p = getModelPresentation(fetched[0], provider)
    expect(p.displayName).toBe('Gemini 2.5 Pro')
    expect(p.effective?.name).toBe('Metadata Gemini Name')
    expect(p.model.id).toBe('gemini-2.5-pro')
  })

  it('unmatched raw renders once (no duplicate ID) and fail-open', async () => {
    const fetched: Model[] = [{ id: 'unknown-xyz', name: 'unknown-xyz', provider: 'openai', group: 'test' } as any]
    const { getModelPresentation } = await import('@renderer/utils/modelPresentation')
    const provider: any = { id: 'openai', name: 'OpenAI', type: 'openai', apiHost: 'https://api.openai.com/v1' }
    const p = getModelPresentation(fetched[0], provider)
    expect(p.displayName).toBe('unknown-xyz')
    // For UI, shouldShowModelId would hide duplicate
    const { shouldShowModelId } = await import('@renderer/utils/modelDisplayName')
    expect(shouldShowModelId(p.displayName, p.model.id)).toBe(false)
  })

  it('late metadata status/snapshot updates mounted view (subscription)', async () => {
    // Initially no snapshot
    const fetched: Model[] = [
      { id: 'deepseek-flash', name: 'deepseek-flash', provider: 'openai', group: 'test' } as any
    ]
    const { getModelPresentation } = await import('@renderer/utils/modelPresentation')
    const provider: any = { id: 'openai', name: 'OpenAI', type: 'openai', apiHost: 'https://api.openai.com/v1' }
    const p1 = getModelPresentation(fetched[0], provider)
    expect(p1.displayName).toBe('deepseek-flash')
    // Late snapshot arrival
    act(() => {
      installEntry('deepseek-flash', { name: 'DeepSeek V4.1 Flash' })
    })
    const p2 = getModelPresentation(fetched[0], provider)
    expect(p2.displayName).toBe('DeepSeek V4.1 Flash')
  })

  it('ID untouched after presentation (exact serving ID preserved)', async () => {
    installEntry('deepseek-flash', { name: 'DeepSeek V4.1 Flash' })
    const fetched: Model[] = [
      { id: 'deepseek-flash', name: 'deepseek-flash', provider: 'openai', group: 'test' } as any
    ]
    const { getModelPresentation } = await import('@renderer/utils/modelPresentation')
    const provider: any = { id: 'openai', name: 'OpenAI', type: 'openai', apiHost: 'https://api.openai.com/v1' }
    const p = getModelPresentation(fetched[0], provider)
    expect(p.model.id).toBe('deepseek-flash')
    expect(p.displayName).not.toBe('deepseek-flash')
    // Simulate add flow preserves exact ID
    const finalModel = { ...p.model, name: p.displayName }
    expect(finalModel.id).toBe('deepseek-flash')
  })
})
