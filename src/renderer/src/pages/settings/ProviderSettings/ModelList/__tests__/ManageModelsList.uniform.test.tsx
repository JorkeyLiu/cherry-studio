import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: ({ model, size }: any) => <div data-testid="model-avatar" data-model-id={model.id} data-size={size} />
}))
vi.mock('@renderer/components/ExpandableText', () => ({ default: () => <div /> }))
vi.mock('@renderer/components/Tags/CustomTag', () => ({ default: ({ children }: any) => <span>{children}</span> }))
vi.mock('@renderer/components/VirtualList', () => ({
  DynamicVirtualList: ({ list, children }: any) => (
    <div>
      {(list as any[]).map((row: any, i: number) => (
        <div key={i}>{typeof children === 'function' ? children(row) : children}</div>
      ))}
    </div>
  )
}))
vi.mock('@renderer/pages/files/FileItem', () => ({
  default: ({ fileInfo }: any) => (
    <div data-testid="file-item">
      {fileInfo?.icon}
      {fileInfo?.name}
    </div>
  )
}))
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (k: string) => k }) }
})

import ManageModelsList from '../ManageModelsList'

describe('ManageModelsList uniform id display', () => {
  const provider: any = { id: 'openai', name: 'OpenAI', models: [] }

  it('shows id uniformly when name differs (not duplicate-gated)', () => {
    const modelGroups = { g: [{ id: 'gpt-4o-2024-08-06', name: 'GPT-4o', provider: 'openai' } as any] }
    render(
      <ManageModelsList
        modelGroups={modelGroups}
        duplicateModelNames={new Set()}
        provider={provider}
        onAddModel={() => {}}
        onRemoveModel={() => {}}
      />
    )
    // uniform: id visible even though name unique
    expect(screen.getByText('GPT-4o')).toBeInTheDocument()
    expect(screen.getByText('gpt-4o-2024-08-06')).toBeInTheDocument()
    expect(document.querySelector('[title="gpt-4o-2024-08-06"]')).not.toBeNull()
  })

  it('hides id when trimmed equal (shows once)', () => {
    const modelGroups = { g: [{ id: 'gpt-4o', name: 'gpt-4o', provider: 'openai' } as any] }
    render(
      <ManageModelsList
        modelGroups={modelGroups}
        duplicateModelNames={new Set(['gpt-4o'])}
        provider={provider}
        onAddModel={() => {}}
        onRemoveModel={() => {}}
      />
    )
    const els = screen.getAllByText('gpt-4o')
    expect(els.length).toBe(1)
    expect(document.querySelector('[title="gpt-4o"]')).toBeNull()
  })

  it('case-sensitive: GPT-4o vs gpt-4o shows id', () => {
    const modelGroups = { g: [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' } as any] }
    render(
      <ManageModelsList
        modelGroups={modelGroups}
        duplicateModelNames={new Set()}
        provider={provider}
        onAddModel={() => {}}
        onRemoveModel={() => {}}
      />
    )
    expect(screen.getByText('GPT-4o')).toBeInTheDocument()
    expect(screen.getByText('gpt-4o')).toBeInTheDocument()
  })
})
