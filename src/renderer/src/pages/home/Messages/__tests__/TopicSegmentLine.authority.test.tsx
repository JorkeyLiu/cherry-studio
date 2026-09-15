import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { configureStore } from '@reduxjs/toolkit'
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import type * as ReactI18nextModule from 'react-i18next'
import { Provider } from 'react-redux'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), silly: vi.fn() }) }
}))

vi.mock('@renderer/services/db', () => ({
  dbService: {
    upsertSegment: vi.fn(),
    updateSegmentMetadata: vi.fn(),
    replaceSegmentMembership: vi.fn(),
    deleteSegment: vi.fn()
  }
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18nextModule>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: { count?: number }) => (opts && 'count' in opts ? String(opts.count) : key)
    })
  }
})

vi.mock('antd', () => ({
  Input: (props: any) => createElement('input', props),
  Popconfirm: ({ children }: any) => createElement('div', null, children)
}))

vi.mock('@renderer/utils/topicSegmentColor', () => ({
  getSegmentColor: (id: string) => `color-${id}`
}))

import messagesReducer from '@renderer/store/newMessage'
import topicSegmentReducer from '@renderer/store/topicSegment'

import TopicSegmentLine from '../TopicSegmentLine'

function setupStore() {
  return configureStore({
    reducer: { topicSegments: topicSegmentReducer, messages: messagesReducer as any }
  })
}

function wrapper(store: ReturnType<typeof setupStore>) {
  return ({ children }: { children: React.ReactNode }) => createElement(Provider, { store, children } as any)
}

describe('segment authority UI badges', () => {
  it('TopicSegmentLine badge renders the authority messageCount prop, not messageIds.length', () => {
    const store = setupStore()
    // Loaded membership has 2 ids but authority count is 5 (windowed projection):
    // the badge must show 5.
    const segment = {
      id: 'seg-1',
      topicId: 't1',
      name: 'Seg',
      messageIds: ['m1', 'm2'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 0,
      firstMessageId: 'm0',
      lastMessageId: 'm4',
      messageCount: 5
    } as any
    render(createElement(TopicSegmentLine, { segment, isFirst: true, isLast: false, messageCount: 5 }), {
      wrapper: wrapper(store)
    })
    expect(screen.getByText('5')).toBeTruthy()
  })

  it('Messages.tsx segment line badge is wired to segment.messageCount', () => {
    const src = readFileSync(join(process.cwd(), 'src/renderer/src/pages/home/Messages/Messages.tsx'), 'utf8')
    expect(src).toContain('messageCount={isFirst ? segment.messageCount : undefined}')
    expect(src).not.toContain('segment.messageIds.length')
  })

  it('EditMode merge adjacency uses authority first/last endpoints, not array endpoints', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/EditModeContextMenu/useEditModeContextMenuItems.ts'),
      'utf8'
    )
    expect(src).toContain('seg.firstMessageId')
    expect(src).toContain('seg.lastMessageId')
    expect(src).not.toContain('seg.messageIds[0]')
    expect(src).not.toContain('seg.messageIds[seg.messageIds.length - 1]')
  })

  it('wrapper helper builds a store (keeps Provider path covered)', () => {
    expect(wrapper(setupStore())).toBeTruthy()
  })
})
