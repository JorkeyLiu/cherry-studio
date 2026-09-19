import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/components/Avatar/ModelAvatar', () => ({
  default: ({ model, provider, size }: any) => (
    <div
      data-testid="model-avatar-stub"
      data-model-id={model?.id}
      data-provider-id={provider?.id ?? ''}
      data-size={size}
    />
  )
}))
vi.mock('@renderer/components/ExpandableText', () => ({ default: () => <div /> }))
vi.mock('@renderer/components/ModelIdWithTags', () => ({ default: () => <div /> }))
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
    <div data-testid="file-item-stub">
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

const provider: any = { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-4o' }] }
const modelGroups = { g: [{ id: 'gpt-4o', name: 'gpt-4o' }] as any[] }

describe('ManageModelsList avatar', () => {
  it('renders each model row with the owning provider ModelAvatar', () => {
    render(
      <ManageModelsList
        modelGroups={modelGroups}
        duplicateModelNames={new Set()}
        provider={provider}
        onAddModel={() => {}}
        onRemoveModel={() => {}}
      />
    )
    const stubs = screen.getAllByTestId('model-avatar-stub')
    expect(stubs.length).toBeGreaterThan(0)
    for (const stub of stubs) {
      expect(stub.getAttribute('data-provider-id')).toBe('openai')
    }
    expect(stubs[0].getAttribute('data-model-id')).toBe('gpt-4o')
  })
})
