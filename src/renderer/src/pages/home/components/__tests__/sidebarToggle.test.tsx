import { configureStore } from '@reduxjs/toolkit'
import { useWorkspaceSidebar } from '@renderer/hooks/useStore'
import settingsReducer, { initialState as settingsInitial } from '@renderer/store/settings'
import { fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { describe, expect, it } from 'vitest'

import SidebarToggle from '../SidebarToggle'

/**
 * SidebarToggle handler contract (jsdom scope).
 *
 * jsdom proves ONLY the handler wiring: the single toggle stays mounted in
 * both visibility states (hidden never unmounts it) and a real click on the
 * actual button invokes the visibility toggle through the real
 * useWorkspaceSidebar hook and the real settings reducer. Whether the
 * native side lets that click land (draggable-region order) is NOT proven
 * here — that is a source contract, see chatTopChrome (11): the toggle
 * renders after Chat so its no-drag subtracts after the chat drag band
 * unions in the native region vector.
 */
function buildStore(visible: boolean) {
  return configureStore({
    reducer: { settings: settingsReducer },
    preloadedState: { settings: { ...settingsInitial, workspaceSidebarVisible: visible } }
  })
}

type TestStore = ReturnType<typeof buildStore>

function Harness({ title }: { title: string }) {
  // Subscribe through the real hook so the click travels the same
  // visible/toggleVisible path HomePage wires into the toggle.
  const { visible, toggleVisible } = useWorkspaceSidebar()
  return <SidebarToggle visible={visible} isFullscreen={false} title={title} onToggle={toggleVisible} />
}

function workspaceVisible(store: TestStore): boolean {
  return store.getState().settings.workspaceSidebarVisible
}

describe('SidebarToggle handler contract', () => {
  it('hidden state keeps the single expand button mounted; a real click re-expands', () => {
    const store = buildStore(false)
    const view = render(
      <Provider store={store as never}>
        <Harness title="show sidebar" />
      </Provider>
    )
    const button = screen.getByTestId('sidebar-collapse-button')
    expect(button).toBeInTheDocument()
    expect(button.querySelector('.lucide-panel-left-open')).not.toBeNull()

    fireEvent.click(button)
    expect(workspaceVisible(store)).toBe(true)
    view.unmount()
  })

  it('visible state keeps the collapse button mounted; a real click collapses', () => {
    const store = buildStore(true)
    const view = render(
      <Provider store={store as never}>
        <Harness title="hide sidebar" />
      </Provider>
    )
    const button = screen.getByTestId('sidebar-collapse-button')
    expect(button).toBeInTheDocument()
    expect(button.querySelector('.lucide-panel-left-close')).not.toBeNull()

    fireEvent.click(button)
    expect(workspaceVisible(store)).toBe(false)
    view.unmount()
  })
})
