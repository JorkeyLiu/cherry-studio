import { MessageBlockType } from '@renderer/types/newMessage'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const onNavigate = vi.fn()
  const loadWholeTopicSnapshot = vi.fn()
  let activeBranchId: string | null = null
  let updatedAt: string | undefined = 't0'
  return {
    onNavigate,
    loadWholeTopicSnapshot,
    getActiveBranchId: () => activeBranchId,
    setActiveBranchId: (v: string | null) => {
      activeBranchId = v
    },
    getUpdatedAt: () => updatedAt,
    setUpdatedAt: (v: string | undefined) => {
      updatedAt = v
    }
  }
})

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }
}))

vi.mock('@renderer/services/EventService', () => ({
  EVENT_NAMES: { MESSAGE_COMPLETE: 'message-complete' },
  EventEmitter: { on: vi.fn(() => vi.fn()), emit: vi.fn() }
}))

vi.mock('react-redux', () => ({
  useSelector: (fn: (state: unknown) => unknown) =>
    fn({
      topicBranch: { activeBranchIdByTopic: { 'topic-1': mocks.getActiveBranchId(), 'topic-2': null } },
      assistants: {
        assistants: [
          {
            topics: [
              { id: 'topic-1', updatedAt: mocks.getUpdatedAt() },
              { id: 'topic-2', updatedAt: 't0' }
            ]
          }
        ]
      }
    })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string; count?: number }) => {
      // Minimal en-us mirror: base keys resolve with interpolation and the
      // same one/other plural semantics the production i18n config applies.
      const count = opts?.count ?? 0
      const name = opts?.name ?? ''
      switch (key) {
        case 'chat.navigation.user_message_fallback':
          return 'Quoted message'
        case 'chat.navigation.user_attachment_fallback':
          return 'Attachment'
        case 'chat.navigation.user_attachment_file':
        case 'chat.navigation.user_attachment_file_more':
        case 'chat.navigation.user_attachment_file_one':
        case 'chat.navigation.user_attachment_file_other':
          // Legacy name+more formatters: the sequential label rule no longer
          // calls them; kept only so older bindings would still resolve.
          return `${name} +${count} ${count === 1 ? 'attachment' : 'attachments'}`
        case 'chat.navigation.user_attachment_type_image':
          return 'Image'
        case 'chat.navigation.user_attachment_type_video':
          return 'Video'
        case 'chat.navigation.user_attachment_type_audio':
          return 'Audio'
        case 'chat.navigation.user_attachment_type_text':
          return 'Text'
        case 'chat.navigation.user_attachment_type_document':
          return 'Document'
        case 'chat.navigation.user_attachment_type_code':
          return 'Code'
        case 'chat.navigation.user_message_link':
          return 'Link'
        default:
          return key
      }
    }
  })
}))

vi.mock('@renderer/utils/topicSnapshot', () => ({
  loadWholeTopicSnapshot: (...args: unknown[]) => mocks.loadWholeTopicSnapshot(...args)
}))

import ConversationNavigation from '../ConversationNavigation'

const textBlock = (id: string, messageId: string, content: string) =>
  ({
    id,
    messageId,
    type: MessageBlockType.MAIN_TEXT,
    content,
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z'
  }) as never

const fileBlock = (id: string, messageId: string) =>
  ({
    id,
    messageId,
    type: MessageBlockType.FILE,
    file: { name: 'doc.pdf' },
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z'
  }) as never

const namedFileBlock = (id: string, messageId: string, originName: string) =>
  ({
    id,
    messageId,
    type: MessageBlockType.FILE,
    file: {
      id: `file-${id}`,
      name: originName,
      origin_name: originName,
      path: `/tmp/${originName}`,
      size: 12,
      ext: '.pdf',
      type: 'document'
    },
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z'
  }) as never

const imageBlock = (id: string, messageId: string, originName?: string) =>
  ({
    id,
    messageId,
    type: MessageBlockType.IMAGE,
    ...(originName
      ? {
          file: {
            id: `img-${id}`,
            name: originName,
            origin_name: originName,
            path: `/tmp/${originName}`,
            type: 'image'
          }
        }
      : {}),
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z'
  }) as never

const videoBlock = (id: string, messageId: string) =>
  ({
    id,
    messageId,
    type: MessageBlockType.VIDEO,
    filePath: '/Users/someone/secret/clip.mp4',
    status: 'success',
    createdAt: '2026-01-01T00:00:00.000Z'
  }) as never

const userMsg = (id: string, blocks: string[]) =>
  ({
    id,
    role: 'user',
    topicId: 'topic-1',
    assistantId: 'asst-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'success',
    blocks
  }) as never

const assistantMsg = (id: string, blocks: string[]) =>
  ({
    id,
    role: 'assistant',
    topicId: 'topic-1',
    assistantId: 'asst-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'success',
    blocks
  }) as never

describe('ConversationNavigation whole-route user list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.setActiveBranchId(null)
    mocks.setUpdatedAt('t0')
  })

  it('lists ALL user messages in chronological order and click navigates by stable ID', async () => {
    const blocks = [
      textBlock('b1', 'u1', 'First question about rivers'),
      textBlock('b2', 'u2', 'Second question about mountains'),
      textBlock('b3', 'a1', 'Assistant heading answer (never listed)')
    ]
    mocks.loadWholeTopicSnapshot.mockResolvedValue({
      messages: [userMsg('u1', ['b1']), assistantMsg('a1', ['b3']), userMsg('u2', ['b2'])],
      blocks,
      blocksById: new Map(blocks.map((b) => [(b as { id: string }).id, b]))
    })

    render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)

    // Whole-route list: both user messages present even though only the tail
    // would be in a loaded projection; the assistant message is excluded.
    const item1 = await screen.findByTestId('conversation-nav-item-u1')
    const item2 = await screen.findByTestId('conversation-nav-item-u2')
    expect(item1.textContent).toContain('First question about rivers')
    expect(item2.textContent).toContain('Second question about mountains')
    expect(screen.queryByTestId('conversation-nav-item-a1')).toBeNull()
    // Chronological conversation order.
    const items = screen.getAllByTestId(/^conversation-nav-item-/)
    expect(items.map((el) => el.getAttribute('data-testid'))).toEqual([
      'conversation-nav-item-u1',
      'conversation-nav-item-u2'
    ])

    // Stable-ID navigation (not DOM/index scrolling).
    fireEvent.click(item2)
    expect(mocks.onNavigate).toHaveBeenCalledWith('u2')
    expect(mocks.loadWholeTopicSnapshot).toHaveBeenCalledWith('topic-1', null)
    // Keyboard activation on the same original row hitbox.
    fireEvent.keyDown(item1, { key: 'Enter' })
    expect(mocks.onNavigate).toHaveBeenCalledWith('u1')
  })

  it('keeps quote-only and attachment-only user items navigable with meaningful labels', async () => {
    const blocks = [textBlock('bq', 'uq', '> only a quote'), fileBlock('f1', 'ua')]
    mocks.loadWholeTopicSnapshot.mockResolvedValue({
      messages: [userMsg('uq', ['bq']), userMsg('ua', ['f1'])],
      blocks,
      blocksById: new Map(blocks.map((b) => [(b as { id: string }).id, b]))
    })

    render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)

    const quoteItem = await screen.findByTestId('conversation-nav-item-uq')
    const attachItem = await screen.findByTestId('conversation-nav-item-ua')
    // Quote-only without attachments keeps the localized message fallback;
    // a typeless file-only row with no classifiable ext reads the generic
    // fallback — filenames are never shown.
    expect(quoteItem.textContent).toContain('Quoted message')
    expect(attachItem.textContent).toContain('[Attachment]')
    expect(attachItem.textContent).not.toContain('doc.pdf')

    fireEvent.click(attachItem)
    expect(mocks.onNavigate).toHaveBeenCalledWith('ua')
  })

  it('prefers body text over attachment clutter and labels attachment-only rows by kind', async () => {
    const longName = `${'n'.repeat(300)}.pdf`
    const blocks = [
      textBlock('bb', 'ub', 'Please review the attached report.'),
      namedFileBlock('fb', 'ub', 'report.pdf'),
      namedFileBlock('f1', 'u1', 'alpha.pdf'),
      namedFileBlock('f2', 'u1', 'beta.pdf'),
      namedFileBlock('f3', 'u1', 'gamma.pdf'),
      imageBlock('i1', 'u2'),
      imageBlock('i2', 'u2'),
      videoBlock('v1', 'u3'),
      namedFileBlock('fl', 'ul', longName)
    ]
    mocks.loadWholeTopicSnapshot.mockResolvedValue({
      messages: [
        userMsg('ub', ['bb', 'fb']),
        userMsg('u1', ['f1', 'f2', 'f3']),
        userMsg('u2', ['i1', 'i2']),
        userMsg('u3', ['v1']),
        userMsg('ul', ['fl'])
      ],
      blocks,
      blocksById: new Map(blocks.map((b) => [(b as { id: string }).id, b]))
    })

    render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)

    // Filtered body shows WITH its attachment kind prefix (no clutter
    // hiding, no added space/dot/count): the document row reads first.
    const bodyItem = await screen.findByTestId('conversation-nav-item-ub')
    expect(bodyItem.textContent).toBe('[Document]Please review the attached report.')
    expect(bodyItem.textContent).not.toContain('report.pdf')

    // Sequential rule: every attachment contributes its kind label in order,
    // duplicates preserved, no counts/merging, no filenames.
    const multiItem = await screen.findByTestId('conversation-nav-item-u1')
    expect(multiItem.textContent).toContain('[Document][Document][Document]')
    expect(multiItem.textContent).not.toContain('alpha.pdf')
    expect(multiItem.textContent).not.toContain('beta.pdf')

    // Two unnamed images keep both labels.
    expect((await screen.findByTestId('conversation-nav-item-u2')).textContent).toContain('[Image][Image]')

    // Nameless video rows use the bracketed video kind, never the path or a bare count.
    const videoItem = await screen.findByTestId('conversation-nav-item-u3')
    expect(videoItem.textContent).toContain('[Video]')
    expect(videoItem.textContent).not.toContain('1 video')
    expect(videoItem.textContent).not.toContain('clip.mp4')

    // A very long stored filename never surfaces: the typed document row
    // reads [Document], and the complete label stays intact in `title`
    // while the single-line ellipsis row (`white-space: nowrap` +
    // `text-overflow: ellipsis`) controls visible overflow.
    const longItem = await screen.findByTestId('conversation-nav-item-ul')
    expect(longItem.textContent).toContain('[Document]')
    expect(longItem.textContent).not.toContain('n'.repeat(10))
    expect(longItem.querySelector('div')).not.toBeNull()
    expect(longItem.getAttribute('title')).toBe(longItem.textContent)

    fireEvent.click(multiItem)
    expect(mocks.onNavigate).toHaveBeenCalledWith('u1')
  })

  it('shows body text with its attachment prefix and replaces links in place', async () => {
    const audioFile = {
      id: 'fa',
      messageId: 'um',
      type: MessageBlockType.FILE,
      file: { id: 'file-fa', name: '', origin_name: '', ext: '.mp3', type: 'audio' },
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z'
    } as never
    const blocks = [
      textBlock('bm', 'um', 'Test'),
      imageBlock('im', 'um'),
      audioFile,
      textBlock('bl', 'ul', 'https://example.com\nTest')
    ]
    mocks.loadWholeTopicSnapshot.mockResolvedValue({
      messages: [userMsg('um', ['bm', 'im', 'fa']), userMsg('ul', ['bl'])],
      blocks,
      blocksById: new Map(blocks.map((b) => [(b as { id: string }).id, b]))
    })

    render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)

    // Attachment prefix in original block order joined directly with the
    // body: no added space, dot, count, or merge.
    const mixed = await screen.findByTestId('conversation-nav-item-um')
    expect(mixed.textContent).toBe('[Image][Audio]Test')
    // External links are replaced in place at their original position; the
    // boundary newline after the bare URL joins (`URL\nTest` → `[Link]Test`).
    const linkItem = await screen.findByTestId('conversation-nav-item-ul')
    expect(linkItem.textContent).toBe('[Link]Test')

    fireEvent.click(mixed)
    expect(mocks.onNavigate).toHaveBeenCalledWith('um')
  })

  it('lists image plus document attachments sequentially in block order, never filenames', async () => {
    const blocks = [imageBlock('i1', 'um'), namedFileBlock('f9', 'um', 'later-report.pdf')]
    mocks.loadWholeTopicSnapshot.mockResolvedValue({
      messages: [userMsg('um', ['i1', 'f9'])],
      blocks,
      blocksById: new Map(blocks.map((b) => [(b as { id: string }).id, b]))
    })

    render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)

    const item = await screen.findByTestId('conversation-nav-item-um')
    expect(item.textContent).toContain('[Image][Document]')
    expect(item.textContent).not.toContain('later-report.pdf')

    fireEvent.click(item)
    expect(mocks.onNavigate).toHaveBeenCalledWith('um')
  })

  it('maps clipboard pasted-image rows to the meaningful app label without leaking IDs', async () => {
    const pasted = 'pasted_image_45285c9c-a7cd-4c3d-a9b6-6854c3bbe479.png'
    const blocks = [imageBlock('i1', 'up', pasted)]
    mocks.loadWholeTopicSnapshot.mockResolvedValue({
      messages: [userMsg('up', ['i1'])],
      blocks,
      blocksById: new Map(blocks.map((b) => [(b as { id: string }).id, b]))
    })

    render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)

    const pastedItem = await screen.findByTestId('conversation-nav-item-up')
    expect(pastedItem.textContent).toContain('[Image]')
    expect(pastedItem.textContent).not.toContain('45285c9c')

    fireEvent.click(pastedItem)
    expect(mocks.onNavigate).toHaveBeenCalledWith('up')
  })

  it('labels FILE audio/text/document and legacy video/code rows through the bound formatters', async () => {
    const audioBlock = {
      id: 'fa',
      messageId: 'ua',
      type: MessageBlockType.FILE,
      file: { id: 'file-fa', name: '', origin_name: '', ext: '.mp3', type: 'audio' },
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z'
    } as never
    const textBlockFile = {
      id: 'ft',
      messageId: 'ut',
      type: MessageBlockType.FILE,
      file: { id: 'file-ft', name: '', origin_name: '', ext: '.md', type: 'text' },
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z'
    } as never
    const docBlock = {
      id: 'fd',
      messageId: 'ud',
      type: MessageBlockType.FILE,
      file: { id: 'file-fd', name: '', origin_name: '', ext: '.pdf', type: 'document' },
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z'
    } as never
    const codeBlock = {
      id: 'cc',
      messageId: 'uc',
      type: MessageBlockType.CODE,
      content: 'print(1)',
      language: 'python',
      status: 'success',
      createdAt: '2026-01-01T00:00:00.000Z'
    } as never
    const blocks = [audioBlock, textBlockFile, docBlock, videoBlock('v1', 'uv'), codeBlock]
    mocks.loadWholeTopicSnapshot.mockResolvedValue({
      messages: [
        userMsg('ua', ['fa']),
        userMsg('ut', ['ft']),
        userMsg('ud', ['fd']),
        userMsg('uv', ['v1']),
        userMsg('uc', ['cc'])
      ],
      blocks,
      blocksById: new Map(blocks.map((b) => [(b as { id: string }).id, b]))
    })

    render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)

    expect((await screen.findByTestId('conversation-nav-item-ua')).textContent).toContain('[Audio]')
    expect((await screen.findByTestId('conversation-nav-item-ut')).textContent).toContain('[Text]')
    expect((await screen.findByTestId('conversation-nav-item-ud')).textContent).toContain('[Document]')
    const videoItem = await screen.findByTestId('conversation-nav-item-uv')
    expect(videoItem.textContent).toContain('[Video]')
    expect(videoItem.textContent).not.toContain('clip.mp4')
    expect((await screen.findByTestId('conversation-nav-item-uc')).textContent).toContain('[Code]')
  })

  it('drops the stale route list on topic switch and loads the new route', async () => {
    const blocks1 = [textBlock('b1', 'u1', 'Old topic question')]
    const blocks2 = [textBlock('b9', 'u9', 'New topic question')]
    mocks.loadWholeTopicSnapshot.mockImplementation(async (topicId: string) => {
      if (topicId === 'topic-1') {
        return {
          messages: [userMsg('u1', ['b1'])],
          blocks: blocks1,
          blocksById: new Map(blocks1.map((b) => [(b as { id: string }).id, b]))
        }
      }
      return {
        messages: [{ ...(userMsg('u9', ['b9']) as unknown as Record<string, unknown>), topicId: 'topic-2' }] as never[],
        blocks: blocks2,
        blocksById: new Map(blocks2.map((b) => [(b as { id: string }).id, b]))
      }
    })

    const { rerender } = render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    await screen.findByTestId('conversation-nav-item-u1')

    rerender(<ConversationNavigation topicId="topic-2" onNavigate={mocks.onNavigate} />)
    // Stale list never renders under the new route.
    await waitFor(() => {
      expect(screen.queryByTestId('conversation-nav-item-u1')).toBeNull()
    })
    expect(await screen.findByTestId('conversation-nav-item-u9')).toBeTruthy()
    expect(mocks.loadWholeTopicSnapshot).toHaveBeenCalledWith('topic-2', null)
  })

  it('drops the stale list synchronously on branch switch within the same topic', async () => {
    const mainBlocks = [textBlock('bm', 'um', 'Main route question')]
    const branchBlocks = [textBlock('bb', 'ub', 'Branch route question')]
    mocks.loadWholeTopicSnapshot.mockImplementation(async (_topic: string, branch: string | null) => {
      if (branch === 'b1') {
        return {
          messages: [userMsg('ub', ['bb'])],
          blocks: branchBlocks,
          blocksById: new Map(branchBlocks.map((b) => [(b as { id: string }).id, b]))
        }
      }
      return {
        messages: [userMsg('um', ['bm'])],
        blocks: mainBlocks,
        blocksById: new Map(mainBlocks.map((b) => [(b as { id: string }).id, b]))
      }
    })

    mocks.setActiveBranchId(null)
    const { rerender } = render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    await screen.findByTestId('conversation-nav-item-um')

    mocks.setActiveBranchId('b1')
    rerender(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    // Synchronous provenance: old-route ID is gone on the very first render
    // under the new branch key, before the new fetch resolves.
    expect(screen.queryByTestId('conversation-nav-item-um')).toBeNull()
    expect(await screen.findByTestId('conversation-nav-item-ub')).toBeTruthy()
    expect(mocks.loadWholeTopicSnapshot).toHaveBeenCalledWith('topic-1', 'b1')
  })

  it('invalidates synchronously while the new snapshot is pending and guards old-ID clicks', async () => {
    const blocks1 = [textBlock('b1', 'u1', 'Old topic question')]
    let resolveNew!: (v: never) => void
    const newPending = new Promise<never>((resolve) => {
      resolveNew = resolve
    })
    mocks.loadWholeTopicSnapshot.mockImplementation(async (topicId: string) => {
      if (topicId === 'topic-1') {
        return {
          messages: [userMsg('u1', ['b1'])],
          blocks: blocks1,
          blocksById: new Map(blocks1.map((b) => [(b as { id: string }).id, b]))
        } as never
      }
      return newPending
    })

    const { rerender } = render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    const oldItem = await screen.findByTestId('conversation-nav-item-u1')
    fireEvent.click(oldItem)
    expect(mocks.onNavigate).toHaveBeenCalledWith('u1')
    mocks.onNavigate.mockClear()

    // New route fetch stays pending: the intermediate render must already be
    // empty — no stale items, no clickable old IDs bound to the new callback.
    rerender(<ConversationNavigation topicId="topic-2" onNavigate={mocks.onNavigate} />)
    expect(screen.queryByTestId('conversation-nav-item-u1')).toBeNull()
    expect(screen.queryByTestId('conversation-navigation')).toBeNull()
    expect(mocks.onNavigate).not.toHaveBeenCalledWith('u1')

    const blocks2 = [textBlock('b9', 'u9', 'New topic question')]
    resolveNew({
      messages: [{ ...(userMsg('u9', ['b9']) as unknown as Record<string, unknown>), topicId: 'topic-2' }] as never[],
      blocks: blocks2,
      blocksById: new Map(blocks2.map((b) => [(b as { id: string }).id, b]))
    } as never)
    expect(await screen.findByTestId('conversation-nav-item-u9')).toBeTruthy()
    fireEvent.click(screen.getByTestId('conversation-nav-item-u9'))
    expect(mocks.onNavigate).toHaveBeenCalledWith('u9')
  })

  it('discards a stale async completion that resolves after a route switch', async () => {
    let resolveOld!: (v: never) => void
    const oldPending = new Promise<never>((resolve) => {
      resolveOld = resolve
    })
    const blocksNew = [textBlock('b9', 'u9', 'New topic question')]
    let call = 0
    mocks.loadWholeTopicSnapshot.mockImplementation(async () => {
      call += 1
      if (call === 1) return oldPending
      return {
        messages: [{ ...(userMsg('u9', ['b9']) as unknown as Record<string, unknown>), topicId: 'topic-2' }] as never[],
        blocks: blocksNew,
        blocksById: new Map(blocksNew.map((b) => [(b as { id: string }).id, b]))
      } as never
    })

    const { rerender } = render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    // First fetch pending: nothing renders yet.
    expect(screen.queryByTestId('conversation-navigation')).toBeNull()

    rerender(<ConversationNavigation topicId="topic-2" onNavigate={mocks.onNavigate} />)
    expect(await screen.findByTestId('conversation-nav-item-u9')).toBeTruthy()

    // The superseded first fetch resolves late with the old route's data —
    // generation + route guards must discard it.
    const staleBlocks = [textBlock('bs', 'us', 'Stale old question')]
    resolveOld({
      messages: [userMsg('us', ['bs'])],
      blocks: staleBlocks,
      blocksById: new Map(staleBlocks.map((b) => [(b as { id: string }).id, b]))
    } as never)
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('conversation-nav-item-us')).toBeNull()
    expect(screen.getByTestId('conversation-nav-item-u9')).toBeTruthy()
  })

  it('keeps the same-route list coherent while a same-route refetch is pending', async () => {
    const blocks1 = [textBlock('b1', 'u1', 'First question')]
    const blocks2 = [textBlock('b1', 'u1', 'First question'), textBlock('b2', 'u2', 'Second question after update')]
    let resolveRefetch!: (v: never) => void
    let refetchStarted = false
    let calls = 0
    mocks.loadWholeTopicSnapshot.mockImplementation(async () => {
      calls += 1
      if (calls === 1) {
        return {
          messages: [userMsg('u1', ['b1'])],
          blocks: blocks1,
          blocksById: new Map(blocks1.map((b) => [(b as { id: string }).id, b]))
        } as never
      }
      refetchStarted = true
      return new Promise<never>((resolve) => {
        resolveRefetch = resolve
      })
    })

    const { rerender } = render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    await screen.findByTestId('conversation-nav-item-u1')

    // Same-route authority mutation triggers a debounced refetch with the SAME
    // route key: the current list must stay visible while pending (no
    // route-boundary invalidation for same-route reloads).
    mocks.setUpdatedAt('t1')
    rerender(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    // Debounce window (250ms) + fetch pending: the loaded list stays coherent.
    await waitFor(() => expect(refetchStarted).toBe(true), { timeout: 5000 })
    expect(screen.getByTestId('conversation-nav-item-u1')).toBeTruthy()

    resolveRefetch({
      messages: [userMsg('u1', ['b1']), userMsg('u2', ['b2'])],
      blocks: blocks2,
      blocksById: new Map(blocks2.map((b) => [(b as { id: string }).id, b]))
    } as never)
    expect(await screen.findByTestId('conversation-nav-item-u2')).toBeTruthy()
    expect(screen.getByTestId('conversation-nav-item-u1')).toBeTruthy()
  })

  it('keeps one isolated row hitbox per entry inside the original outline body', async () => {
    const blocks = [
      textBlock('b1', 'u1', 'First question about rivers'),
      textBlock('b2', 'u2', 'Second question about mountains'),
      textBlock('b3', 'u3', 'Third question about deserts')
    ]
    mocks.loadWholeTopicSnapshot.mockResolvedValue({
      messages: [userMsg('u1', ['b1']), userMsg('u2', ['b2']), userMsg('u3', ['b3'])],
      blocks,
      blocksById: new Map(blocks.map((b) => [(b as { id: string }).id, b]))
    })

    const { container } = render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)

    await screen.findByTestId('conversation-nav-item-u3')
    // One compact hitbox per row in the restored original outline DOM
    // (Container > Body > Item divs): every item owns exactly one stable-ID
    // row, so no neighbor row can intercept another row's click point.
    const nav = container.querySelector('[data-testid="conversation-navigation"]')
    expect(nav).not.toBeNull()
    expect(nav?.tagName).toBe('DIV')
    const body = nav!.firstElementChild as HTMLElement | null
    expect(body).not.toBeNull()
    const rows = Array.from(body!.querySelectorAll(':scope > div[data-message-id]'))
    expect(rows.length).toBe(3)
    for (const row of rows) {
      // Original hierarchy per row: indicator dot div + ellipsis text div.
      expect(row.querySelectorAll(':scope > div').length).toBe(2)
      expect(row.getAttribute('role')).toBe('button')
    }
    const buttons = screen.getAllByTestId(/^conversation-nav-item-/)
    expect(buttons.map((el) => el.getAttribute('data-message-id'))).toEqual(['u1', 'u2', 'u3'])
  })
})
