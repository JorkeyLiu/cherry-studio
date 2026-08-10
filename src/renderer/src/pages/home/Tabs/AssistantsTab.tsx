import Scrollbar from '@renderer/components/Scrollbar'
import { useAssistants } from '@renderer/hooks/useAssistant'
import { useAssistantPresets } from '@renderer/hooks/useAssistantPresets'
import type { Assistant } from '@renderer/types'
import type { FC } from 'react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import * as tinyPinyin from 'tiny-pinyin'

import AssistantAddButton from './components/AssistantAddButton'
import { AssistantList } from './components/AssistantList'

interface AssistantsTabProps {
  activeAssistant: Assistant
  setActiveAssistant: (assistant: Assistant) => void
  onCreateAssistant: () => void
  onCreateDefaultAssistant: () => void
}

// LOCK-007: the tag-based view switching is removed; the assistant list always
// renders in list form. Assistant tags data itself is preserved.
const AssistantsTab: FC<AssistantsTabProps> = (props) => {
  const { activeAssistant, setActiveAssistant, onCreateAssistant, onCreateDefaultAssistant } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const { t } = useTranslation()

  // Assistant related hooks
  const { assistants, removeAssistant, copyAssistant, updateAssistants } = useAssistants()
  const { addAssistantPreset } = useAssistantPresets()
  const [dragging, setDragging] = useState(false)

  // Sorting
  const sortByPinyin = useCallback(
    (isAscending: boolean) => {
      const sorted = [...assistants].sort((a, b) => {
        const pinyinA = tinyPinyin.convertToPinyin(a.name, '', true)
        const pinyinB = tinyPinyin.convertToPinyin(b.name, '', true)
        return isAscending ? pinyinA.localeCompare(pinyinB) : pinyinB.localeCompare(pinyinA)
      })
      updateAssistants(sorted)
    },
    [assistants, updateAssistants]
  )

  const sortByPinyinAsc = useCallback(() => sortByPinyin(true), [sortByPinyin])
  const sortByPinyinDesc = useCallback(() => sortByPinyin(false), [sortByPinyin])

  const onDeleteAssistant = useCallback(
    (assistant: Assistant) => {
      const remaining = assistants.filter((a) => a.id !== assistant.id)
      if (remaining.length === 0) {
        window.toast.error(t('assistants.delete.error.remain_one'))
        return
      }

      if (assistant.id === activeAssistant?.id) {
        const newActive = remaining[remaining.length - 1]
        setActiveAssistant(newActive)
      }
      removeAssistant(assistant.id)
    },
    [assistants, activeAssistant?.id, removeAssistant, t, setActiveAssistant]
  )

  return (
    <Container className="assistants-tab" ref={containerRef}>
      <AssistantAddButton onCreateAssistant={onCreateAssistant} />

      <AssistantList
        items={assistants}
        activeAssistantId={activeAssistant.id}
        onReorder={updateAssistants}
        onDragStart={() => setDragging(true)}
        onDragEnd={() => setDragging(false)}
        onAssistantSwitch={setActiveAssistant}
        onAssistantDelete={onDeleteAssistant}
        addPreset={addAssistantPreset}
        copyAssistant={copyAssistant}
        onCreateDefaultAssistant={onCreateDefaultAssistant}
        sortByPinyinAsc={sortByPinyinAsc}
        sortByPinyinDesc={sortByPinyinDesc}
      />

      {!dragging && <div style={{ minHeight: 10 }}></div>}
    </Container>
  )
}

const Container = styled(Scrollbar)`
  display: flex;
  flex-direction: column;
  padding: 12px 10px;
`

export default AssistantsTab
