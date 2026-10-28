import { createAntdThemeConfig } from '@renderer/context/antdThemeConfig'
import { MessageEditingProvider } from '@renderer/context/MessageEditingContext'
import { useSettings } from '@renderer/hooks/useSettings'
import store from '@renderer/store'
import type { ThemeMode, Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import type { SnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
import { ConfigProvider } from 'antd'
import { memo, type PropsWithChildren, useMemo } from 'react'
import { Provider } from 'react-redux'

import MessageItem from './Message'
import { createMessageViewportGroupModel } from './messageGroups'

interface Props {
  topic: Topic
  /** Complete ordered topic messages from the caller-local whole-topic snapshot. */
  messages: Message[]
  /** Caller-local snapshot blocks; never the loaded Redux block projection. */
  blocksById: SnapshotBlockMap
  /** Layout width in CSS pixels (the live message column width when available). */
  width: number
  /** Effective theme of the live page (`dark`/`light`), read at export start. */
  themeMode: ThemeMode
}

/**
 * Resolves the messages that are actually laid out for a topic.
 *
 * Multi-answer groups render in fold mode everywhere in the runtime: exactly
 * one member of the group is displayed and the others are `display:none`
 * siblings. Selecting the same single member here keeps the exported image
 * faithful to the rendered conversation instead of stacking every answer, and
 * keeps the group helpers (`createMessageViewportGroupModel`) as the single
 * grouping authority for both the viewport projection and this render.
 */
export const selectVisibleExportMessages = (messages: Message[]): Message[] => {
  const model = createMessageViewportGroupModel(messages)
  const visible: Message[] = []
  for (const group of model.groups) {
    if (group.messages.length === 1) {
      visible.push(group.messages[0])
      continue
    }
    const selected = group.messages.find((message) => message.foldSelected) ?? group.messages[0]
    visible.push(selected)
  }
  return visible
}

/**
 * antd scope for the detached export root.
 *
 * React context does not cross a second root, so without this the exported
 * subtree would render with antd's default (light) tokens while the page is
 * dark — visible as an exported thinking-block header painted with light-theme
 * heading/body colors. Only the *configuration* is re-applied here: the config
 * comes from the same builder the live `AntdProvider` uses, and the effective
 * mode is passed in from the live page, so nothing here resolves, writes or
 * listens for the global theme. The user's primary color is read from the same
 * settings state the live provider reads.
 */
const TopicExportAntdTheme = ({ themeMode, children }: PropsWithChildren<{ themeMode: ThemeMode }>) => {
  const {
    userTheme: { colorPrimary }
  } = useSettings()

  return <ConfigProvider theme={createAntdThemeConfig({ themeMode, colorPrimary })}>{children}</ConfigProvider>
}

/**
 * Offscreen render of one complete topic for image export.
 *
 * The component is pure presentation over caller-local snapshot data: it reads
 * no windowed/loaded message projection, mounts no viewport/scroll machinery
 * and writes nothing to the global store. Messages render through the ordinary
 * message body (header + content blocks resolved from the injected snapshot
 * blocks) with the toolbars omitted, matching the existing read-only topic
 * rendering used by the history preview.
 */
const TopicExportImageCanvas = ({ topic, messages, blocksById, width, themeMode }: Props) => {
  const visibleMessages = useMemo(() => selectVisibleExportMessages(messages), [messages])

  return (
    // The canvas mounts in a detached root (outside the app tree), so it owns
    // the store provider its message body needs. Reads stay plain projections;
    // nothing here dispatches export data into the store.
    <Provider store={store}>
      <MessageEditingProvider>
        <TopicExportAntdTheme themeMode={themeMode}>
          <div
            className="bubble"
            data-topic-export-content
            style={{
              width,
              display: 'flex',
              flexDirection: 'column',
              boxSizing: 'border-box',
              padding: '10px 10px 20px',
              backgroundColor: 'var(--color-background)',
              color: 'var(--color-text)'
            }}>
            {visibleMessages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                topic={topic}
                hideMenuBar
                // Duplicate `message-<id>` DOM anchors would collide with the live
                // chat rows and divert viewport geometry reads during the export.
                renderDomId={false}
                snapshotBlocksById={blocksById}
              />
            ))}
          </div>
        </TopicExportAntdTheme>
      </MessageEditingProvider>
    </Provider>
  )
}

export default memo(TopicExportImageCanvas)
