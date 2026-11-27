import AddAssistantPopup from '@renderer/components/Popups/AddAssistantPopup'
import { useAssistantDefaults, useAssistants } from '@renderer/hooks/useAssistant'
import { createAssistantFromDefaults } from '@renderer/services/assistantDefaults'
import type { Assistant, Topic } from '@renderer/types'
import { classNames } from '@renderer/utils'
import type { CSSProperties, FC } from 'react'
import styled from 'styled-components'

import Assistants from './AssistantsTab'

interface Props {
  activeAssistant: Assistant
  activeTopic: Topic
  setActiveAssistant: (assistant: Assistant) => void
  setActiveTopic: (topic: Topic) => void
  /** @deprecated the unified workspace sidebar owns navigation; HomeTabs only
   *  serves the temporary assistants drawer (always the assistant list). */
  position?: 'left' | 'right'
  style?: CSSProperties
}

// Unified navigation: the workspace sidebar renders Topics directly in its
// middle and opens the assistant list as a temporary drawer. HomeTabs keeps
// the assistant-list rendering for that temporary drawer only; the permanent
// right topic panel is removed.
const HomeTabs: FC<Props> = ({ activeAssistant, activeTopic, setActiveAssistant, setActiveTopic, style }) => {
  const { addAssistant } = useAssistants()
  const { assistantDefaults } = useAssistantDefaults()

  const tabsWidthStyle = {
    '--tabs-width': 'var(--workspace-sidebar-width, 300px)'
  } as CSSProperties

  const onCreateAssistant = async () => {
    const assistant = await AddAssistantPopup.show()
    if (assistant) {
      setActiveAssistant(assistant)
    }
  }

  const onCreateDefaultAssistant = async () => {
    // Ordinary entity built from pure defaults (new id + fresh topic).
    const assistant = createAssistantFromDefaults(assistantDefaults)
    // LOCK-533: topic ownership persists in SQLite before Redux exposure.
    await addAssistant(assistant)
    setActiveAssistant(assistant)
  }

  void activeTopic
  void setActiveTopic

  return (
    <Container style={{ ...tabsWidthStyle, ...style }} className={classNames('home-tabs')}>
      <TabContent className="home-tabs-content">
        <Assistants
          activeAssistant={activeAssistant}
          setActiveAssistant={setActiveAssistant}
          onCreateAssistant={onCreateAssistant}
          onCreateDefaultAssistant={onCreateDefaultAssistant}
        />
      </TabContent>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  width: var(--tabs-width, 300px);
  transition: width 0.3s;
  height: calc(100vh - var(--navbar-height));
  position: relative;

  background-color: var(--color-background);
  overflow: hidden;
`

const TabContent = styled.div`
  display: flex;
  transition: width 0.3s;
  flex: 1;
  flex-direction: column;
  overflow-y: hidden;
  overflow-x: hidden;
`

export default HomeTabs
