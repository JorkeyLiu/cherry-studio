import type { TopicBranchWire } from '@renderer/services/db/types'
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
        case 'chat.topics.branch.children_here':
          return `${count} branches here`
        default:
          return key
      }
    }
  })
}))

vi.mock('@renderer/utils/topicSnapshot', () => ({
  loadWholeTopicSnapshot: (...args: unknown[]) => mocks.loadWholeTopicSnapshot(...args)
}))

// Branch catalog stub: the outline reads the same relation source the message
// flow uses. The real hook reaches the app store, so the harness supplies the
// exact projection (`childrenByAnchor`) the component consumes.
const branchTree = vi.hoisted(() => {
  let childrenByAnchor: Map<string, unknown[]> = new Map()
  let path: unknown[] = []
  return {
    get: () => childrenByAnchor,
    set: (value: Map<string, unknown[]>) => {
      childrenByAnchor = value
    },
    // Root-first branch chain of the viewed route: what tells the fork's taken
    // child apart from its siblings.
    getPath: () => path,
    setPath: (value: unknown[]) => {
      path = value
    },
    reset: () => {
      childrenByAnchor = new Map()
      path = []
    }
  }
})

vi.mock('../useBranchTree', () => ({
  useBranchTree: () => ({
    branches: [],
    activeNode: undefined,
    path: branchTree.getPath(),
    children: [],
    childrenByAnchor: branchTree.get(),
    ownAnchorMessageId: null,
    routeGeneration: 0,
    hasBranches: branchTree.get().size > 0
  }),
  requestTopicBranches: vi.fn()
}))

import ConversationNavigation from '../ConversationNavigation'
import type { ReadingAnchorReport } from '../Messages'

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

/**
 * Pointer navigation the way the product now allows it: the rows take the
 * pointer only once the expand switch has fully settled (MessageOutline's
 * pointer gate), so a click is preceded by the expansion hover and its settle
 * window — the same wait Playwright's actionability retries perform against the
 * real UI, and the reason these cases stay about navigation, not about layout.
 */
const clickOutlineRow = async (row: HTMLElement) => {
  const nav = row.closest('[data-testid="conversation-navigation"]') as HTMLElement
  const panel = nav.querySelector('[data-testid="conversation-nav-panel"]') as HTMLElement
  fireEvent.mouseEnter(nav)
  await waitFor(() => expect(panel.getAttribute('data-outline-interactive')).toBe('ready'))
  fireEvent.click(row)
}

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
    await clickOutlineRow(item2)
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

    await clickOutlineRow(attachItem)
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

    await clickOutlineRow(multiItem)
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

    await clickOutlineRow(mixed)
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

    await clickOutlineRow(item)
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

    await clickOutlineRow(pastedItem)
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
    await clickOutlineRow(oldItem)
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
    await clickOutlineRow(screen.getByTestId('conversation-nav-item-u9'))
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

  it('refetches on the first real updatedAt when the topic mounted without one', async () => {
    const blocks1 = [textBlock('b1', 'u1', 'First question')]
    const blocks2 = [textBlock('b1', 'u1', 'First question'), textBlock('b2', 'u2', 'Inserted question')]
    let calls = 0
    mocks.loadWholeTopicSnapshot.mockImplementation(async () => {
      calls += 1
      return (
        calls === 1
          ? {
              messages: [userMsg('u1', ['b1'])],
              blocks: blocks1,
              blocksById: new Map(blocks1.map((b) => [(b as { id: string }).id, b]))
            }
          : {
              messages: [userMsg('u1', ['b1']), userMsg('u2', ['b2'])],
              blocks: blocks2,
              blocksById: new Map(blocks2.map((b) => [(b as { id: string }).id, b]))
            }
      ) as never
    })

    // First mount of this route: the persisted topic carries NO updatedAt yet.
    mocks.setUpdatedAt(undefined)
    const { rerender } = render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    await screen.findByTestId('conversation-nav-item-u1')
    expect(mocks.loadWholeTopicSnapshot).toHaveBeenCalledTimes(1)

    // The first REAL timestamp is an authority mutation, not a baseline: the
    // message inserted now must reach the outline.
    mocks.setUpdatedAt('t1')
    rerender(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    expect(await screen.findByTestId('conversation-nav-item-u2', {}, { timeout: 5000 })).toBeTruthy()
    expect(mocks.loadWholeTopicSnapshot).toHaveBeenCalledTimes(2)
    // The existing row is still there: the refetch is additive, not a reset.
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
    // (Container > Body > measured content > Item divs): every item owns exactly
    // one stable-ID row, so no neighbor row can intercept another row's click
    // point. The extra boxes are the clip and the animated width; they never
    // become rows.
    const nav = container.querySelector('[data-testid="conversation-navigation"]')
    expect(nav).not.toBeNull()
    expect(nav?.tagName).toBe('DIV')
    const body = nav!.firstElementChild as HTMLElement | null
    expect(body).not.toBeNull()
    const rows = Array.from(body!.querySelectorAll('div[data-message-id]'))
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

describe('ConversationNavigation reading-anchor highlight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.setActiveBranchId(null)
    mocks.setUpdatedAt('t0')
  })

  const seedThread = () => {
    const blocks = [
      textBlock('b1', 'u1', 'First question about rivers'),
      textBlock('ba1', 'a1', 'First assistant answer'),
      textBlock('ba1b', 'a1b', 'First assistant follow-up'),
      textBlock('b2', 'u2', 'Second question about mountains'),
      textBlock('ba2', 'a2', 'Second assistant answer')
    ]
    mocks.loadWholeTopicSnapshot.mockResolvedValue({
      messages: [
        userMsg('u1', ['b1']),
        assistantMsg('a1', ['ba1']),
        assistantMsg('a1b', ['ba1b']),
        userMsg('u2', ['b2']),
        assistantMsg('a2', ['ba2'])
      ],
      blocks,
      blocksById: new Map(blocks.map((b) => [(b as { id: string }).id, b]))
    })
  }

  const anchor = (over: Partial<ReadingAnchorReport>): ReadingAnchorReport => ({
    topicId: 'topic-1',
    route: null,
    messageId: null,
    navigationTargetId: null,
    ...over
  })

  const renderNav = (readingAnchor: ReadingAnchorReport) =>
    render(<ConversationNavigation topicId="topic-1" readingAnchor={readingAnchor} onNavigate={mocks.onNavigate} />)

  const activeRowId = () =>
    screen
      .getAllByTestId(/^conversation-nav-item-/)
      .find((el) => el.getAttribute('aria-current') === 'true')
      ?.getAttribute('data-message-id') ?? null

  it('maps an answer report to its preceding user turn, including consecutive answers', async () => {
    seedThread()
    const { rerender } = renderNav(anchor({ messageId: 'a1', navigationTargetId: 'a1' }))
    await screen.findByTestId('conversation-nav-item-u2')
    expect(activeRowId()).toBe('u1')

    // A consecutive second answer still belongs to the same user turn.
    rerender(
      <ConversationNavigation
        topicId="topic-1"
        readingAnchor={anchor({ messageId: 'a1b', navigationTargetId: 'a1b' })}
        onNavigate={mocks.onNavigate}
      />
    )
    expect(activeRowId()).toBe('u1')

    rerender(
      <ConversationNavigation
        topicId="topic-1"
        readingAnchor={anchor({ messageId: 'a2', navigationTargetId: 'a2' })}
        onNavigate={mocks.onNavigate}
      />
    )
    expect(activeRowId()).toBe('u2')
  })

  it('prefers navigationTargetId over a stale messageId', async () => {
    seedThread()
    renderNav(anchor({ messageId: 'u1', navigationTargetId: 'a2' }))
    await screen.findByTestId('conversation-nav-item-u2')
    expect(activeRowId()).toBe('u2')
  })

  it('highlights a user report directly — user ids never resolve through the map', async () => {
    seedThread()
    renderNav(anchor({ messageId: 'u2', navigationTargetId: 'u2' }))
    await screen.findByTestId('conversation-nav-item-u2')
    // Direct hit on u2, never remapped to the earlier u1.
    expect(activeRowId()).toBe('u2')
  })

  it('leaves every row unhighlighted for an unresolvable report id', async () => {
    seedThread()
    renderNav(anchor({ messageId: 'ghost', navigationTargetId: 'ghost' }))
    await screen.findByTestId('conversation-nav-item-u2')
    expect(activeRowId()).toBeNull()
  })

  it('drops the highlight for stale topic or branch reports', async () => {
    seedThread()
    const { rerender } = renderNav(anchor({ messageId: 'u1', navigationTargetId: 'u1' }))
    await screen.findByTestId('conversation-nav-item-u2')
    expect(activeRowId()).toBe('u1')

    // A report for another topic never highlights under this topic.
    rerender(
      <ConversationNavigation
        topicId="topic-1"
        readingAnchor={anchor({ topicId: 'topic-2', messageId: 'u1', navigationTargetId: 'u1' })}
        onNavigate={mocks.onNavigate}
      />
    )
    expect(activeRowId()).toBeNull()

    // A report for another branch never highlights under the main route.
    rerender(
      <ConversationNavigation
        topicId="topic-1"
        readingAnchor={anchor({ route: 'b1', messageId: 'u1', navigationTargetId: 'u1' })}
        onNavigate={mocks.onNavigate}
      />
    )
    expect(activeRowId()).toBeNull()
  })

  it('never shows the old route highlight while the new snapshot is pending', async () => {
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

    const { rerender } = render(
      <ConversationNavigation
        topicId="topic-1"
        readingAnchor={anchor({ messageId: 'u1', navigationTargetId: 'u1' })}
        onNavigate={mocks.onNavigate}
      />
    )
    await screen.findByTestId('conversation-nav-item-u1')
    expect(activeRowId()).toBe('u1')

    // Route switch with the new fetch still pending: no stale rows at all.
    rerender(
      <ConversationNavigation
        topicId="topic-2"
        readingAnchor={anchor({ topicId: 'topic-2', messageId: 'u9', navigationTargetId: 'u9' })}
        onNavigate={mocks.onNavigate}
      />
    )
    expect(screen.queryByTestId('conversation-nav-item-u1')).toBeNull()

    const blocks2 = [textBlock('b9', 'u9', 'New topic question')]
    resolveNew({
      messages: [{ ...(userMsg('u9', ['b9']) as unknown as Record<string, unknown>), topicId: 'topic-2' }] as never[],
      blocks: blocks2,
      blocksById: new Map(blocks2.map((b) => [(b as { id: string }).id, b]))
    } as never)
    expect(await screen.findByTestId('conversation-nav-item-u9')).toBeTruthy()
    expect(activeRowId()).toBe('u9')
  })

  it('highlights under the matching branch route once its snapshot loads', async () => {
    seedThread()
    mocks.setActiveBranchId('b1')
    renderNav(anchor({ route: 'b1', messageId: 'u2', navigationTargetId: 'u2' }))
    expect(mocks.loadWholeTopicSnapshot).toHaveBeenCalledWith('topic-1', 'b1')
    expect(await screen.findByTestId('conversation-nav-item-u2')).toBeTruthy()
    expect(activeRowId()).toBe('u2')
  })
})

describe('ConversationNavigation fork markers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.setActiveBranchId(null)
    mocks.setUpdatedAt('t0')
    branchTree.reset()
  })

  /** u1 / a1 / u2 / a2 — the outline lists the two user rows only. */
  const seedForkThread = () => {
    const blocks = [
      textBlock('b1', 'u1', 'First question about rivers'),
      textBlock('ba1', 'a1', 'First assistant answer'),
      textBlock('b2', 'u2', 'Second question about mountains'),
      textBlock('ba2', 'a2', 'Second assistant answer')
    ]
    mocks.loadWholeTopicSnapshot.mockResolvedValue({
      messages: [
        userMsg('u1', ['b1']),
        assistantMsg('a1', ['ba1']),
        userMsg('u2', ['b2']),
        assistantMsg('a2', ['ba2'])
      ],
      blocks,
      blocksById: new Map(blocks.map((b) => [(b as { id: string }).id, b]))
    })
  }

  /** u1 / a1 / a1b / u2 / a2 — assistant turns can arrive in runs. */
  const seedAssistantChainThread = () => {
    const blocks = [
      textBlock('b1', 'u1', 'First question about rivers'),
      textBlock('ba1', 'a1', 'First assistant answer'),
      textBlock('ba1x', 'a1b', 'First assistant answer, regenerated'),
      textBlock('b2', 'u2', 'Second question about mountains'),
      textBlock('ba2', 'a2', 'Second assistant answer')
    ]
    mocks.loadWholeTopicSnapshot.mockResolvedValue({
      messages: [
        userMsg('u1', ['b1']),
        assistantMsg('a1', ['ba1']),
        assistantMsg('a1b', ['ba1x']),
        userMsg('u2', ['b2']),
        assistantMsg('a2', ['ba2'])
      ],
      blocks,
      blocksById: new Map(blocks.map((b) => [(b as { id: string }).id, b]))
    })
  }

  /** a0 / u1 / a1 / u2 — an assistant turn BEFORE the first user question. */
  const seedLeadingAssistantThread = () => {
    const blocks = [
      textBlock('ba0', 'a0', 'Greeting before any question'),
      textBlock('b1', 'u1', 'First question about rivers'),
      textBlock('ba1', 'a1', 'First assistant answer'),
      textBlock('b2', 'u2', 'Second question about mountains')
    ]
    mocks.loadWholeTopicSnapshot.mockResolvedValue({
      messages: [
        assistantMsg('a0', ['ba0']),
        userMsg('u1', ['b1']),
        assistantMsg('a1', ['ba1']),
        userMsg('u2', ['b2'])
      ],
      blocks,
      blocksById: new Map(blocks.map((b) => [(b as { id: string }).id, b]))
    })
  }

  const wire = (
    anchorMessageId: string,
    inheritedBoundary?: TopicBranchWire['inheritedBoundary'],
    overrides?: { id?: string; name?: string | null }
  ): TopicBranchWire => ({
    id: overrides?.id ?? `br-${anchorMessageId}`,
    topicId: 'topic-1',
    parentBranchId: null,
    anchorMessageId,
    ...(inheritedBoundary === undefined ? {} : { inheritedBoundary }),
    name: overrides?.name ?? null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: null
  })

  const forkRows = () => screen.queryAllByTestId('conversation-nav-fork')

  // The outline's rows live inside its measured content box
  // (nav > body > panel > content), where the fork marker is a sibling of the
  // message rows.
  const rowListOf = (nav: HTMLElement) =>
    nav.querySelector('[data-testid="conversation-nav-panel"]')!.firstElementChild as HTMLElement

  it('marks the row of the resolved inheritance boundary, never the raw anchor', async () => {
    seedForkThread()
    // The branch is anchored on the ASSISTANT turn a2, but its inherited
    // history ends at the user turn u2 — exactly where the message stream
    // draws the divider. Reading the raw anchor would mark nothing here.
    branchTree.set(new Map([['a2', [wire('a2', { kind: 'message', messageId: 'u2' })]]]) as Map<string, unknown[]>)

    const { container } = render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    const row = await screen.findByTestId('conversation-nav-item-u2')
    await screen.findByTestId('conversation-nav-item-u1')

    expect(forkRows()).toHaveLength(1)
    const fork = forkRows()[0]
    // Directly AFTER the u2 row, inside the same row list.
    const body = container.querySelector('[data-testid="conversation-navigation"]')!.firstElementChild as HTMLElement
    expect(Array.from(rowListOf(body).children).indexOf(fork)).toBe(
      Array.from(rowListOf(body).children).indexOf(row) + 1
    )
    expect(fork.previousElementSibling).toBe(row)
    // u1 is untouched.
    expect(screen.getByTestId('conversation-nav-item-u1').nextElementSibling).toBe(row)
  })

  it('maps an assistant placement message onto its nearest preceding user row', async () => {
    seedForkThread()
    // Placement resolves to an assistant turn — the normal case, because the
    // split action lives on assistant turns and Main reports the anchor itself
    // as the boundary while it stays on its parent route. The outline lists
    // user rows only, so the marker lands under the user turn that assistant
    // answered (u1) — where the reader experienced the fork.
    branchTree.set(new Map([['a1', [wire('a1', { kind: 'message', messageId: 'a1' })]]]) as Map<string, unknown[]>)

    const { container } = render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    const row = await screen.findByTestId('conversation-nav-item-u1')
    const laterRow = await screen.findByTestId('conversation-nav-item-u2')

    expect(forkRows()).toHaveLength(1)
    const fork = forkRows()[0]
    // Directly AFTER the u1 row, inside the same row list.
    const body = container.querySelector('[data-testid="conversation-navigation"]')!.firstElementChild as HTMLElement
    expect(Array.from(rowListOf(body).children).indexOf(fork)).toBe(
      Array.from(rowListOf(body).children).indexOf(row) + 1
    )
    expect(fork.previousElementSibling).toBe(row)
    // Exactly one marker: the later user row is untouched.
    expect(laterRow.previousElementSibling).toBe(fork)
  })

  it('resolves through a run of assistant turns to the user row that opened it', async () => {
    seedAssistantChainThread()
    // u1 / a1 / a1b / u2: the boundary is the second consecutive assistant
    // turn; its nearest preceding user row is still u1, not u2.
    branchTree.set(new Map([['a1b', [wire('a1b', { kind: 'message', messageId: 'a1b' })]]]) as Map<string, unknown[]>)

    render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    const row = await screen.findByTestId('conversation-nav-item-u1')
    const laterRow = await screen.findByTestId('conversation-nav-item-u2')

    expect(forkRows()).toHaveLength(1)
    expect(forkRows()[0].previousElementSibling).toBe(row)
    expect(laterRow.previousElementSibling).toBe(forkRows()[0])
  })

  it('emits no marker when no user row precedes the boundary message', async () => {
    seedLeadingAssistantThread()
    // a0 / u1 / a1 / u2: the leading assistant turn has no preceding user row
    // to belong under, so there is nothing to mark.
    branchTree.set(new Map([['a0', [wire('a0', { kind: 'message', messageId: 'a0' })]]]) as Map<string, unknown[]>)

    render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    await screen.findByTestId('conversation-nav-item-u1')
    await screen.findByTestId('conversation-nav-item-u2')
    expect(forkRows()).toHaveLength(0)
  })

  it('keeps a user placement message on its own row without shifting it backwards', async () => {
    seedForkThread()
    // Regression guard for the direct case: a user boundary is its own row.
    branchTree.set(new Map([['a1', [wire('a1', { kind: 'message', messageId: 'u1' })]]]) as Map<string, unknown[]>)

    render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    const row = await screen.findByTestId('conversation-nav-item-u1')
    const laterRow = await screen.findByTestId('conversation-nav-item-u2')

    expect(forkRows()).toHaveLength(1)
    expect(forkRows()[0].previousElementSibling).toBe(row)
    expect(laterRow.previousElementSibling).toBe(forkRows()[0])
  })

  it('keeps one marker when two distinct forks resolve to the same user row', async () => {
    seedAssistantChainThread()
    // Two assistant anchors (a1 and the regenerated a1b) both inherit up to u1,
    // so both boundaries resolve to the same user row: one marker, not two.
    branchTree.set(
      new Map([
        ['a1', [wire('a1', { kind: 'message', messageId: 'a1' })]],
        ['a1b', [wire('a1b', { kind: 'message', messageId: 'a1b' })]]
      ]) as Map<string, unknown[]>
    )

    render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    const row = await screen.findByTestId('conversation-nav-item-u1')
    await screen.findByTestId('conversation-nav-item-u2')

    expect(forkRows()).toHaveLength(1)
    expect(forkRows()[0].previousElementSibling).toBe(row)
  })

  it('emits no marker for a head fork and none for an off-list boundary', async () => {
    seedForkThread()
    branchTree.set(
      new Map([
        // Head boundary: nothing is inherited, so there is no row to sit under.
        ['u1', [wire('u1', { kind: 'head', messageId: null })]],
        // Boundary message outside the current route's user rows.
        ['u2', [wire('u2', { kind: 'message', messageId: 'ghost' })]]
      ]) as Map<string, unknown[]>
    )

    render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    await screen.findByTestId('conversation-nav-item-u2')
    expect(forkRows()).toHaveLength(0)
  })

  it('falls back to the anchor row when the wire carries no boundary fact', async () => {
    seedForkThread()
    // Same fallback the message stream uses: absence of the fact is not
    // evidence of an empty prefix, so the anchor row places the marker.
    branchTree.set(new Map([['u1', [wire('u1')]]]) as Map<string, unknown[]>)

    const { container } = render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    const row = await screen.findByTestId('conversation-nav-item-u1')
    await screen.findByTestId('conversation-nav-item-u2')
    expect(forkRows()).toHaveLength(1)
    expect(forkRows()[0].previousElementSibling).toBe(row)
    expect(container.querySelectorAll('[data-message-id]')).toHaveLength(2)
  })

  /**
   * The text the outline marker must carry while expanded: the branch the
   * viewed route actually travels at the fork (the child on the root-first
   * `path`), or — when the route took no child there — the message flow's
   * children-here count form. Both come from the shared `forkMarkerLabel`
   * rule, so this helper asserts the geometry and returns the text.
   */
  const revealedForkText = (container: HTMLElement): string => {
    const body = container.querySelector('[data-testid="conversation-navigation"]')!.firstElementChild as HTMLElement
    // The marker's label is mounted in both states (its compact clip and opacity
    // are the switch, never a mount), so the same text is there collapsed and
    // expanded; what this helper proves is that it is the label the flow
    // resolved, flanked by the two rules.
    const collapsed = forkRows()[0]
    expect(collapsed.children).toHaveLength(3)
    fireEvent.mouseEnter(body)
    const expanded = forkRows()[0]
    // line + text + line: the text is the middle element, the two rules flank it.
    expect(expanded.children).toHaveLength(3)
    const [, name] = Array.from(expanded.children)
    expect(name.textContent).toBe(expanded.textContent)
    return expanded.textContent ?? ''
  }

  it('names the marker with the child branch the current route travels through', async () => {
    seedForkThread()
    const taken = wire('a2', { kind: 'message', messageId: 'u2' }, { id: 'br-taken', name: 'Rivers branch' })
    // The viewed route is main → br-taken, so that is the branch at this fork.
    branchTree.setPath([taken])
    branchTree.set(new Map([['a2', [taken]]]) as Map<string, unknown[]>)

    const { container } = render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    const row = await screen.findByTestId('conversation-nav-item-u2')
    await screen.findByTestId('conversation-nav-item-u1')

    expect(forkRows()).toHaveLength(1)
    expect(revealedForkText(container)).toBe('Rivers branch')
    // The marker is still a separate row after the message row, not that row.
    expect(forkRows()[0].previousElementSibling).toBe(row)
  })

  it('names the sibling the current route travels, never another branch of the same fork', async () => {
    seedForkThread()
    // Two siblings at the same fork (same anchor, same parent route): the first
    // in the deterministic child order is NOT the one this route took.
    const siblingAlpha = wire('a2', { kind: 'message', messageId: 'u2' }, { id: 'br-a', name: 'Alpha branch' })
    const siblingBeta = wire('a2', { kind: 'message', messageId: 'u2' }, { id: 'br-b', name: 'Beta branch' })
    mocks.setActiveBranchId('br-b')
    branchTree.setPath([siblingBeta])
    branchTree.set(new Map([['a2', [siblingAlpha, siblingBeta]]]) as Map<string, unknown[]>)

    const { container } = render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    await screen.findByTestId('conversation-nav-item-u2')
    await screen.findByTestId('conversation-nav-item-u1')

    expect(mocks.loadWholeTopicSnapshot).toHaveBeenCalledWith('topic-1', 'br-b')
    expect(forkRows()).toHaveLength(1)
    const text = revealedForkText(container)
    expect(text).toBe('Beta branch')
    expect(text).not.toBe('Alpha branch')
  })

  it('falls back to the flow children-here count when the route took no child at the fork', async () => {
    seedForkThread()
    // The fork's children all sit on OTHER routes (the viewed route stayed on
    // its parent route here), so there is no branch name to show. The marker
    // must then carry the message flow's untaken-fork text — never a bare line.
    const elsewhere = wire('a2', { kind: 'message', messageId: 'u2' }, { id: 'br-other', name: 'Other branch' })
    branchTree.setPath([])
    branchTree.set(new Map([['a2', [elsewhere]]]) as Map<string, unknown[]>)

    const { container } = render(<ConversationNavigation topicId="topic-1" onNavigate={mocks.onNavigate} />)
    const row = await screen.findByTestId('conversation-nav-item-u2')
    await screen.findByTestId('conversation-nav-item-u1')

    expect(forkRows()).toHaveLength(1)
    // The shared label rule, resolved through i18n: one child at this fork.
    expect(revealedForkText(container)).toBe('1 branches here')
    expect(forkRows()[0].previousElementSibling).toBe(row)
  })
})
