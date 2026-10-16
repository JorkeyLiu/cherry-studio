import type { HistoryReferenceMeta } from '@shared/chatDb'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) => (opts?.name ? `${key}:${opts.name}` : key)
  })
}))

const { ReferenceDivider } = await import('../ReferenceDivider')

const reference = (over: Partial<HistoryReferenceMeta> = {}): HistoryReferenceMeta => ({
  sourceTopicId: 'src-1',
  sourceBranchId: null,
  anchorMessageId: 'anchor-1',
  sourceName: 'Source',
  status: 'available',
  boundaryMessageId: 'b-1',
  ...over
})

describe('ReferenceDivider', () => {
  it('renders the live source title link and navigates on click', () => {
    const onNavigateSource = vi.fn()
    render(<ReferenceDivider reference={reference()} sourceName="Live Source" onNavigateSource={onNavigateSource} />)
    const divider = screen.getByTestId('history-reference-divider')
    expect(divider.getAttribute('data-reference-status')).toBe('available')
    expect(divider.getAttribute('data-reference-source-topic')).toBe('src-1')
    const link = screen.getByTestId('history-reference-divider-link')
    expect(link.textContent).toBe('chat.message.reference_divider.label:Live Source')
    fireEvent.click(link)
    expect(onNavigateSource).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('history-reference-divider-missing')).toBeNull()
  })

  it('falls back to the refreshed authority name when no live Redux title exists', () => {
    render(
      <ReferenceDivider
        reference={reference({ sourceName: 'Authority Source' })}
        sourceName={null}
        onNavigateSource={() => {}}
      />
    )
    expect(screen.getByTestId('history-reference-divider-link').textContent).toBe(
      'chat.message.reference_divider.label:Authority Source'
    )
  })

  it('renders the missing label with no link when the source is gone', () => {
    render(
      <ReferenceDivider
        reference={reference({ status: 'missing', sourceName: null, boundaryMessageId: null })}
        sourceName={null}
        onNavigateSource={() => {}}
      />
    )
    const divider = screen.getByTestId('history-reference-divider')
    expect(divider.getAttribute('data-reference-status')).toBe('missing')
    expect(screen.getByTestId('history-reference-divider-missing').textContent).toBe(
      'chat.message.reference_divider.missing'
    )
    expect(screen.queryByTestId('history-reference-divider-link')).toBeNull()
  })
})
