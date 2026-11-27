import AddAssistantPopup from '@renderer/components/Popups/AddAssistantPopup'
import { useAssistantDefaults, useAssistants } from '@renderer/hooks/useAssistant'
import { createAssistantFromDefaults } from '@renderer/services/assistantDefaults'
import type { Assistant } from '@renderer/types'
import { Popover } from 'antd'
import type { FC, ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import styled from 'styled-components'

import AssistantsTab from '../../Tabs/AssistantsTab'

interface Props {
  activeAssistant: Assistant
  setActiveAssistant: (assistant: Assistant) => void
  /** Single trigger element the dropdown anchors to (must accept a ref). */
  children: ReactElement
}

/**
 * Assistant switcher dropdown anchored to the current-assistant trigger.
 * A temporary Popover reusing AssistantsTab — never a second permanent
 * column. Selecting an assistant applies it and closes; Escape closes and
 * returns focus to the trigger (the only mounted `[data-testid=
 * "assistant-switcher"]`).
 */
const AssistantSwitcher: FC<Props> = ({ activeAssistant, setActiveAssistant, children }) => {
  const [open, setOpen] = useState(false)
  const { addAssistant } = useAssistants()
  const { assistantDefaults } = useAssistantDefaults()

  const selectAndClose = useCallback(
    (assistant: Assistant) => {
      setActiveAssistant(assistant)
      setOpen(false)
    },
    [setActiveAssistant]
  )

  const onCreateAssistant = useCallback(async () => {
    const assistant = await AddAssistantPopup.show()
    if (assistant) {
      selectAndClose(assistant)
    }
  }, [selectAndClose])

  const onCreateDefaultAssistant = useCallback(async () => {
    const assistant = createAssistantFromDefaults(assistantDefaults)
    await addAssistant(assistant)
    selectAndClose(assistant)
  }, [assistantDefaults, addAssistant, selectAndClose])

  // Escape closes the dropdown. A row editor takes Escape for itself and
  // stops the event, so cancelling an edit never closes the whole switcher.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('[data-testid="assistant-switcher"]')?.focus()
      })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <Popover
      trigger="click"
      placement="bottomLeft"
      arrow={false}
      open={open}
      onOpenChange={setOpen}
      destroyOnHidden
      overlayInnerStyle={{
        padding: 0,
        background: 'var(--color-background)',
        border: '0.5px solid var(--color-border)',
        borderRadius: 'var(--list-item-border-radius)',
        boxShadow: 'none'
      }}
      content={
        <Panel>
          <AssistantsTab
            activeAssistant={activeAssistant}
            setActiveAssistant={selectAndClose}
            onCreateAssistant={() => void onCreateAssistant()}
            onCreateDefaultAssistant={() => void onCreateDefaultAssistant()}
          />
        </Panel>
      }>
      {children}
    </Popover>
  )
}

const Panel = styled.div`
   /* Resolve the legacy row-width var locally: AssistantItem rows size from
      --assistants-width, undefined inside this overlay — bind it to the live
      sidebar width so rows fill the panel exactly like Topics rows. */
   --assistants-width: var(--workspace-sidebar-width, 300px);
   width: var(--workspace-sidebar-width, 300px);
   max-width: calc(100vw - 32px);
   max-height: min(480px, 60vh);
   overflow-y: auto;
   /* Align the reused AssistantsTab gutter with the Topics list gutter so
      the add-assistant header, rows, and menu buttons line up with the
      Topics area. Scoped to this overlay only — AssistantsTab is untouched. */
   && > * {
     padding: 8px 0 10px 10px;
   }
 `

export default AssistantSwitcher
