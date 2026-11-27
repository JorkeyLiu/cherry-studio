import AssistantAvatar from '@renderer/components/Avatar/AssistantAvatar'
import { isMac } from '@renderer/config/constant'
import { useFullscreen } from '@renderer/hooks/useFullscreen'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useSettings } from '@renderer/hooks/useSettings'
import type { Assistant, Topic } from '@renderer/types'
import { ChevronDown } from 'lucide-react'
import type { FC } from 'react'
import styled from 'styled-components'

import { Topics } from '../../Tabs/components/Topics'
import UpdateAppButton from '../UpdateAppButton'
import AssistantSwitcher from './AssistantSwitcher'
import WorkspaceSidebarFooter from './WorkspaceSidebarFooter'

interface Props {
  activeAssistant: Assistant
  activeTopic: Topic
  setActiveAssistant: (assistant: Assistant) => void
  setActiveTopic: (topic: Topic) => void
}

/**
 * Unified workspace sidebar: the single left panel replacing the former
 * assistants + topics dual panels. Header owns the current-assistant
 * switcher (temporary AssistantSwitcher dropdown, never a second permanent
 * column); the middle reuses Topics directly (search, new, pinned, grouping,
 * manage, recycle-bin drawer); the footer reuses the former root-rail app
 * entries. Collapse is fully hidden (no narrow rail): the single
 * expand/collapse toggle lives at Home level and slides with the panel, so
 * this column carries no toggle of its own — only the drag band.
 */
const WorkspaceSidebar: FC<Props> = ({ activeAssistant, activeTopic, setActiveAssistant, setActiveTopic }) => {
  const isFullscreen = useFullscreen()
  const { update } = useRuntime()
  const { autoCheckUpdate } = useSettings()
  // The utility row only ever carries the update entry (search moved to the
  // top-right tool group, the duplicate new-topic entry is gone): render it
  // solely while an update is actionable so no empty bordered row remains.
  // Mirrors UpdateAppButton's own visibility so the entry is never lost.
  const showUpdateEntry = !!update && !!update.downloaded && !!autoCheckUpdate && !update.ignore

  return (
    <Container data-testid="workspace-sidebar">
      <Titlebar $isFullscreen={isFullscreen} />
      <Header>
        <AssistantSwitcher activeAssistant={activeAssistant} setActiveAssistant={setActiveAssistant}>
          <SwitcherButton data-testid="assistant-switcher" title={activeAssistant.name}>
            <AssistantAvatar assistant={activeAssistant} size={24} />
            <SwitcherName>{activeAssistant.name}</SwitcherName>
            <ChevronDown size={16} />
          </SwitcherButton>
        </AssistantSwitcher>
      </Header>
      <Middle>
        <Topics assistant={activeAssistant} activeTopic={activeTopic} setActiveTopic={setActiveTopic} />
      </Middle>
      {showUpdateEntry && (
        <UtilityRow data-testid="workspace-utility-row">
          <UpdateAppButton />
        </UtilityRow>
      )}
      <WorkspaceSidebarFooter />
    </Container>
  )
}

const Container = styled.div`
   display: flex;
   flex-direction: column;
   box-sizing: border-box;
   width: var(--workspace-sidebar-width, 300px);
   min-width: 0;
   height: 100%;
   background-color: var(--color-background);
   overflow: hidden;
 `

// DRAG OWNERSHIP (home sidebar + chat header): a top titlebar band is the
// ONLY element that declares -webkit-app-region: drag — Titlebar here for
// the sidebar column, the app Navbar for the chat column. Nothing below the
// band (Header, Middle, UtilityRow, footer, chat Content) re-declares drag;
// only real interactive controls (switcher, model/branch/edit/settings
// tools) opt out with no-drag. On macOS the band IS the traffic-light strip
// (min-height env(titlebar-area-height)); the single Home-level toggle floats
// above it as a sibling, never inside this column, so the slide is never
// clipped by the panel's overflow.
const Titlebar = styled.div<{ $isFullscreen: boolean }>`
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-height: ${({ $isFullscreen }) => (isMac && !$isFullscreen ? 'max(30px, env(titlebar-area-height, 30px))' : '30px')};
  padding: 0 8px;
  -webkit-app-region: drag;
`

const Header = styled.div`
  // Explicitly non-draggable: only the Titlebar band above drags. The
  // switcher row (and its button, which also opts out itself) never does.
  -webkit-app-region: no-drag;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 8px 4px;
`

const SwitcherButton = styled.button`
   display: flex;
   align-items: center;
   gap: 8px;
   min-width: 0;
   width: 100%;
   border: none;
   background: transparent;
   cursor: pointer;
   border-radius: 8px;
   padding: 6px 8px;
   color: var(--color-text-1);
  -webkit-app-region: no-drag;
  &:hover {
    background-color: var(--color-background-soft);
  }
 `

const SwitcherName = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 600;
  text-align: left;
 `

const Middle = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
`

const UtilityRow = styled.div`
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  border-top: 0.5px solid var(--color-border);
`

export default WorkspaceSidebar
