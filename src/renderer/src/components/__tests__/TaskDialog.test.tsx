import AddProviderPopup from '@renderer/pages/settings/ProviderSettings/AddProviderPopup'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TaskDialog } from '../TaskDialog'
import TopViewContainer, { TopView } from '../TopView'
import { getTopViewLayerCount } from '../TopView/layers'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

vi.mock('@renderer/services/ImageStorage', () => ({
  default: { get: vi.fn().mockResolvedValue(null), set: vi.fn(), remove: vi.fn() }
}))

// jsdom shims for Ant Design Modal/Select (house pattern): matchMedia for
// responsive observer, single-arg getComputedStyle for scrollbar measurement.
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
{
  const originalGetComputedStyle = window.getComputedStyle.bind(window)
  Object.defineProperty(window, 'getComputedStyle', {
    writable: true,
    value: ((elt: Element) => originalGetComputedStyle(elt)) as typeof window.getComputedStyle
  })
}

vi.mock('@renderer/databases', () => ({ default: {}, db: {} }))

vi.mock('@renderer/hooks/useAppInit', () => ({
  useAppInit: () => undefined
}))

vi.mock('@renderer/hooks/useShortcuts', () => ({
  useShortcuts: () => ({ shortcuts: [] })
}))

const renderDialog = (props?: { title?: string; width?: number; onClose?: () => void; children?: React.ReactNode }) => {
  const onClose = props?.onClose ?? vi.fn()
  const utils = render(
    <TaskDialog title={props?.title ?? 'Settings'} width={props?.width ?? 1000} onClose={onClose}>
      {props?.children ?? <div data-testid="task-content">Content</div>}
    </TaskDialog>
  )
  return { ...utils, onClose }
}

beforeEach(() => {
  document.body.innerHTML = ''
  TopView.clear()
})

describe('TaskDialog — centered in-app modal task shell', () => {
  it('renders a headerless floating panel: no title row, no close button, accessible name kept', async () => {
    renderDialog({ title: 'Settings' })

    const seam = await screen.findByTestId('task-dialog')
    // Style-only seam: it carries no dialog semantics of its own.
    expect(seam).not.toHaveAttribute('role')
    expect(seam).not.toHaveAttribute('aria-modal')
    // Antd owns exactly one native dialog; the task title stays its accessible
    // name even though no header row renders it.
    const dialogs = document.querySelectorAll('[role="dialog"]')
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]).toHaveAccessibleName('Settings')
    // No visible header chrome and no close affordance anywhere.
    expect(document.querySelector('.ant-modal-header')).toBeNull()
    expect(document.querySelector('.ant-modal-title')).toBeNull()
    expect(document.querySelector('.ant-modal-close')).toBeNull()
    expect(screen.queryByTestId('task-dialog-close')).not.toBeInTheDocument()
    expect(screen.queryByText('Settings')).not.toBeInTheDocument()
    expect(screen.getByTestId('task-content')).toBeInTheDocument()
    // The body is the surface's only child, so it owns the full available height.
    const content = document.querySelector('.ant-modal-content') as HTMLElement
    expect(content).not.toBeNull()
    expect(content.children).toHaveLength(1)
    expect(content.children[0]).toHaveClass('ant-modal-body')
    expect(content.children[0] as HTMLElement).toContainElement(screen.getByTestId('task-content'))
    // Mask is rendered: pointer input behind the dialog is blocked.
    expect(document.querySelector('.ant-modal-mask')).not.toBeNull()
    // No footer chrome either.
    expect(document.querySelector('.ant-modal-footer')).toBeNull()
  })

  it('closes exactly once on a backdrop click outside the panel', async () => {
    const { onClose } = renderDialog()

    const seam = await screen.findByTestId('task-dialog')
    // The wrap is antd's outside surface: it fills the screen above the mask and
    // is what a user physically clicks next to the floating panel.
    const wrap = seam.closest('.ant-modal-wrap') as HTMLElement
    expect(wrap).not.toBeNull()

    fireEvent.click(wrap)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('never closes on clicks inside the panel', async () => {
    const { onClose } = renderDialog()

    const seam = await screen.findByTestId('task-dialog')
    // Inside the body content, on the panel surface, and on the seam itself:
    // all three are inside the floating panel, never a backdrop dismissal.
    fireEvent.click(screen.getByTestId('task-content'))
    fireEvent.click(document.querySelector('.ant-modal-content') as HTMLElement)
    fireEvent.click(seam)

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('task-dialog')).toBeInTheDocument()
  })

  it('closes with Escape and moves focus into the dialog on open', async () => {
    const { onClose } = renderDialog()

    const dialog = await screen.findByTestId('task-dialog')
    const wrap = dialog.closest('.ant-modal-wrap') as HTMLElement
    expect(wrap).not.toBeNull()
    // Focus lands on the dialog trap entry (the dialog panel or its focus
    // sentinel), i.e. inside the modal wrap rather than on body.
    await waitFor(() => expect(wrap.contains(document.activeElement)).toBe(true))

    fireEvent.keyDown(wrap, { key: 'Escape', keyCode: 27, which: 27 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close the parent behind a layered TopView child on a parent backdrop click', async () => {
    const parentClose = vi.fn()
    render(
      <TopViewContainer>
        <TaskDialog title="Settings" width={1000} onClose={parentClose}>
          <div data-testid="task-content">Content</div>
        </TaskDialog>
      </TopViewContainer>
    )

    await screen.findByTestId('task-dialog')
    void AddProviderPopup.show()
    expect(await screen.findByText('settings.provider.add.title')).toBeInTheDocument()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2)

    // Sibling overlay events can reach the parent wrapper: the topmost-layer
    // rule must win, so this click never closes the task behind the child.
    fireEvent.click(screen.getByTestId('task-dialog').closest('.ant-modal-wrap') as HTMLElement)

    expect(parentClose).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2)
    await waitFor(() => expect(screen.getByTestId('task-content')).toBeVisible())

    TopView.clear()
  })

  it('closes only the topmost child on its own backdrop click, never the parent', async () => {
    const parentClose = vi.fn()
    render(
      <TopViewContainer>
        <TaskDialog title="Settings" width={1000} onClose={parentClose}>
          <div data-testid="task-content">Content</div>
        </TaskDialog>
      </TopViewContainer>
    )

    await screen.findByTestId('task-dialog')
    void AddProviderPopup.show()
    expect(await screen.findByText('settings.provider.add.title')).toBeInTheDocument()

    // The child renders its own wrapper above the parent's: clicking outside the
    // child closes the child only, and the task never becomes orphaned.
    const wraps = Array.from(document.querySelectorAll('.ant-modal-wrap')) as HTMLElement[]
    expect(wraps).toHaveLength(2)
    fireEvent.click(wraps[1])

    await waitFor(() => expect(screen.queryByText('settings.provider.add.title')).not.toBeInTheDocument())
    expect(parentClose).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    await waitFor(() => expect(screen.getByTestId('task-content')).toBeVisible())

    TopView.clear()
  })

  it('routes parent Escape to the topmost real TopView child: child closes, parent survives', async () => {
    const parentClose = vi.fn()
    render(
      <TopViewContainer>
        <TaskDialog title="Settings" width={1000} onClose={parentClose}>
          <div data-testid="task-content">Content</div>
        </TaskDialog>
      </TopViewContainer>
    )

    await screen.findByTestId('task-dialog')
    // The actual production child: AddProvider popup through the real global
    // TopView holder (a sibling subtree outside the task dialog), not a
    // simplified portal nested inside the task content.
    void AddProviderPopup.show()
    expect(await screen.findByText('settings.provider.add.title')).toBeInTheDocument()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2)

    // Focus never left the task page (e.g. it sits on the "Add Provider"
    // button): Escape originates inside the parent wrapper. The parent must
    // yield — only the topmost TopView child closes.
    fireEvent.keyDown(screen.getByTestId('task-content'), { key: 'Escape', keyCode: 27, which: 27 })

    await waitFor(() => expect(screen.queryByText('settings.provider.add.title')).not.toBeInTheDocument())
    expect(parentClose).not.toHaveBeenCalled()
    // Exactly one native dialog remains: the parent task, still visible.
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    await waitFor(() => expect(screen.getByTestId('task-content')).toBeVisible())

    TopView.clear()
  })

  it('lets child Escape close the real TopView child first while the parent stays open', async () => {
    const parentClose = vi.fn()
    render(
      <TopViewContainer>
        <TaskDialog title="Settings" width={1000} onClose={parentClose}>
          <div data-testid="task-content">Content</div>
        </TaskDialog>
      </TopViewContainer>
    )

    await screen.findByTestId('task-dialog')
    void AddProviderPopup.show()
    expect(await screen.findByText('settings.provider.add.title')).toBeInTheDocument()

    // Focus inside the child (the later wrapper in DOM order): the child's own
    // Escape closes it; the parent never sees the event.
    const wraps = Array.from(document.querySelectorAll('.ant-modal-wrap'))
    expect(wraps.length).toBe(2)
    fireEvent.keyDown(wraps[1], { key: 'Escape', keyCode: 27, which: 27 })

    await waitFor(() => expect(screen.queryByText('settings.provider.add.title')).not.toBeInTheDocument())
    expect(parentClose).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    await waitFor(() => expect(screen.getByTestId('task-content')).toBeVisible())

    TopView.clear()
  })

  it('does not steal Escape from inner overlays that consume it (menu/dropdown priority)', async () => {
    const parentClose = vi.fn()
    render(
      <TopViewContainer>
        <TaskDialog title="Settings" width={1000} onClose={parentClose}>
          {/* Stands in for a Select/menu popup: it handles Escape itself and
              stops propagation, so neither the task nor the TopView child close. */}
          <div data-testid="consuming-overlay" onKeyDown={(e) => e.stopPropagation()}>
            overlay
          </div>
        </TaskDialog>
      </TopViewContainer>
    )

    await screen.findByTestId('task-dialog')
    void AddProviderPopup.show()
    expect(await screen.findByText('settings.provider.add.title')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByTestId('consuming-overlay'), { key: 'Escape', keyCode: 27, which: 27 })

    expect(screen.getByText('settings.provider.add.title')).toBeInTheDocument()
    expect(parentClose).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2)

    TopView.clear()
  })

  it('restores parent Escape once the nested child is gone', async () => {
    const parentClose = vi.fn()
    render(
      <TopViewContainer>
        <TaskDialog title="Settings" width={1000} onClose={parentClose}>
          <div data-testid="task-content">Content</div>
        </TaskDialog>
      </TopViewContainer>
    )

    await screen.findByTestId('task-dialog')
    expect(getTopViewLayerCount()).toBe(0)

    const dialog = screen.getByTestId('task-dialog')
    fireEvent.keyDown(dialog.closest('.ant-modal-wrap')!, { key: 'Escape', keyCode: 27, which: 27 })
    expect(parentClose).toHaveBeenCalledTimes(1)

    TopView.clear()
  })

  // ---- Focus ownership across the route-driven close -------------------
  // The failure this covers: rc-dialog restores its saved outside owner only
  // in the leave-motion callback, which an immediate route unmount bypasses,
  // so a task opened from the chat textarea closed with focus on `body`.

  it('returns focus to the invoking chat field after the route unmounts the dialog', async () => {
    const RouteShell = ({ open }: { open: boolean }) => (
      <div>
        <textarea data-testid="chat-draft" defaultValue="" />
        {open ? (
          <TaskDialog title="Settings" width={1000} onClose={() => undefined}>
            <div data-testid="task-content">Content</div>
          </TaskDialog>
        ) : null}
      </div>
    )
    const { rerender } = render(<RouteShell open={false} />)

    const draft = screen.getByTestId('chat-draft') as HTMLTextAreaElement
    draft.focus()
    expect(document.activeElement).toBe(draft)

    // Route open: the task mounts and antd takes focus into the dialog.
    rerender(<RouteShell open />)
    await screen.findByTestId('task-dialog')
    const dialogWrap = screen.getByTestId('task-dialog').closest('.ant-modal-wrap')
    await waitFor(() => expect(dialogWrap!.contains(document.activeElement)).toBe(true))

    // Route close: the task unmounts (no leave motion to restore focus).
    rerender(<RouteShell open={false} />)
    await waitFor(() => expect(document.activeElement).toBe(draft))
    expect(screen.queryByTestId('task-dialog')).not.toBeInTheDocument()
    // The draft itself is untouched (focus restore never re-renders Chat).
    expect(draft).toHaveValue('')
  })

  it('does not force focus when no element was focused before opening', async () => {
    // Mouse on a non-focusable Sidebar control: `body` is the owner, so the
    // close must not invent one.
    const { unmount } = render(
      <TaskDialog title="Files" width={1100} onClose={() => undefined}>
        <div data-testid="task-content">Content</div>
      </TaskDialog>
    )
    await screen.findByTestId('task-dialog')

    unmount()
    await waitFor(() => expect(screen.queryByTestId('task-dialog')).not.toBeInTheDocument())
    expect(document.activeElement).toBe(document.body)
  })

  it('keeps focus on the task when switching task routes (no jump back to Chat)', async () => {
    const Switchable = ({ route }: { route: 'files' | 'settings' }) => (
      <div>
        <textarea data-testid="chat-draft" defaultValue="" />
        {route === 'files' ? (
          <TaskDialog title="Files" width={1100} onClose={() => undefined}>
            <div data-testid="files-content">Files</div>
          </TaskDialog>
        ) : (
          <TaskDialog title="Settings" width={1000} onClose={() => undefined}>
            <div data-testid="settings-content">Settings</div>
          </TaskDialog>
        )}
      </div>
    )
    const { rerender } = render(<Switchable route="files" />)
    await screen.findByTestId('files-content')

    const draft = screen.getByTestId('chat-draft') as HTMLTextAreaElement
    draft.focus()
    rerender(<Switchable route="settings" />)

    expect(await screen.findByTestId('settings-content')).toBeInTheDocument()
    const wrap = screen.getByTestId('task-dialog').closest('.ant-modal-wrap')
    await waitFor(() => expect(wrap!.contains(document.activeElement)).toBe(true))
    expect(document.activeElement).not.toBe(draft)
  })

  it('leaves focus with the nested popup, then returns it to the task (never to Chat)', async () => {
    const Shell = ({ open }: { open: boolean }) => (
      <TopViewContainer>
        <textarea data-testid="chat-draft" defaultValue="" />
        {open ? (
          <TaskDialog title="Settings" width={1000} onClose={() => undefined}>
            <div data-testid="task-content">Content</div>
          </TaskDialog>
        ) : null}
      </TopViewContainer>
    )
    const { rerender } = render(<Shell open={false} />)

    const draft = screen.getByTestId('chat-draft') as HTMLTextAreaElement
    draft.focus()
    rerender(<Shell open />)
    await screen.findByTestId('task-dialog')

    void AddProviderPopup.show()
    expect(await screen.findByText('settings.provider.add.title')).toBeInTheDocument()

    // Parent unmounted while the popup is still layered: Chat must not take
    // focus away from the topmost popup.
    rerender(<Shell open={false} />)
    await waitFor(() => expect(screen.queryByTestId('task-dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(document.activeElement).not.toBe(draft))

    TopView.clear()
  })

  it('returns focus to the open task after a nested popup closes, not to Chat', async () => {
    const Shell = ({ open }: { open: boolean }) => (
      <TopViewContainer>
        <textarea data-testid="chat-draft" defaultValue="" />
        {open ? (
          <TaskDialog title="Settings" width={1000} onClose={() => undefined}>
            <div data-testid="task-content">Content</div>
          </TaskDialog>
        ) : null}
      </TopViewContainer>
    )
    const { rerender } = render(<Shell open={false} />)

    const draft = screen.getByTestId('chat-draft') as HTMLTextAreaElement
    draft.focus()
    rerender(<Shell open />)
    await screen.findByTestId('task-dialog')

    void AddProviderPopup.show()
    expect(await screen.findByText('settings.provider.add.title')).toBeInTheDocument()

    const wraps = Array.from(document.querySelectorAll('.ant-modal-wrap'))
    expect(wraps.length).toBe(2)
    fireEvent.keyDown(wraps[1], { key: 'Escape', keyCode: 27, which: 27 })

    await waitFor(() => expect(screen.queryByText('settings.provider.add.title')).not.toBeInTheDocument())
    const parentWrap = screen.getByTestId('task-dialog').closest('.ant-modal-wrap')
    await waitFor(() => expect(parentWrap!.contains(document.activeElement)).toBe(true))
    expect(document.activeElement).not.toBe(draft)

    TopView.clear()
  })
})
