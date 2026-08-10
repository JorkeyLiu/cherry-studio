import AddAssistantPopup from '@renderer/components/Popups/AddAssistantPopup'
import { useAssistants, useDefaultAssistant } from '@renderer/hooks/useAssistant'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import type { Assistant, Topic } from '@renderer/types'
import { classNames, uuid } from '@renderer/utils'
import type { CSSProperties, FC } from 'react'
import styled from 'styled-components'

import Assistants from './AssistantsTab'
import Topics from './TopicsTab'

interface Props {
  activeAssistant: Assistant
  activeTopic: Topic
  setActiveAssistant: (assistant: Assistant) => void
  setActiveTopic: (topic: Topic) => void
  position: 'left' | 'right'
  style?: CSSProperties
}

// LOCK-002: navigation is fixed on the left. The left panel always renders the
// assistant list; the right panel always renders topics. No tab switching.
const HomeTabs: FC<Props> = ({ activeAssistant, activeTopic, setActiveAssistant, setActiveTopic, position, style }) => {
  const { addAssistant } = useAssistants()
  const { defaultAssistant } = useDefaultAssistant()

  const borderStyle = '0.5px solid var(--color-border)'
  const border =
    position === 'left' ? { borderRight: borderStyle } : { borderLeft: borderStyle, borderTopLeftRadius: 0 }
  const tabsWidthStyle = {
    '--tabs-width': position === 'right' ? 'var(--topic-list-width, 275px)' : 'var(--assistants-width, 275px)'
  } as CSSProperties

  const onCreateAssistant = async () => {
    const assistant = await AddAssistantPopup.show()
    if (assistant) {
      setActiveAssistant(assistant)
    }
  }

  const onCreateDefaultAssistant = async () => {
    const newId = uuid()
    const assistant = { ...defaultAssistant, id: newId, topics: [getDefaultTopic(newId)] }
    // LOCK-533: topic ownership persists in SQLite before Redux exposure.
    await addAssistant(assistant)
    setActiveAssistant(assistant)
  }

  return (
    <Container
      style={{ ...border, ...tabsWidthStyle, ...style }}
      className={classNames('home-tabs', { right: position === 'right' })}>
      <TabContent className="home-tabs-content">
        {position === 'left' ? (
          <Assistants
            activeAssistant={activeAssistant}
            setActiveAssistant={setActiveAssistant}
            onCreateAssistant={onCreateAssistant}
            onCreateDefaultAssistant={onCreateDefaultAssistant}
          />
        ) : (
          <Topics assistant={activeAssistant} activeTopic={activeTopic} setActiveTopic={setActiveTopic} />
        )}
      </TabContent>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  width: var(--tabs-width, 275px);
  transition: width 0.3s;
  height: calc(100vh - var(--navbar-height));
  position: relative;

  &.right {
    height: calc(100vh - var(--navbar-height));
  }

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
