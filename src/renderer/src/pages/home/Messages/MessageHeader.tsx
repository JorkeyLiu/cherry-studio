import DefaultUserAvatar, { isDefaultUserAvatar } from '@renderer/components/Avatar/DefaultUserAvatar'
import EmojiAvatar from '@renderer/components/Avatar/EmojiAvatar'
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { HStack } from '@renderer/components/Layout'
import UserPopup from '@renderer/components/Popups/UserPopup'
import { APP_NAME, AppLogo, isLocalAi } from '@renderer/config/env'
import { useTheme } from '@renderer/context/ThemeProvider'
import type { MessageAssistantConfig } from '@renderer/hooks/useAssistant'
import useAvatar from '@renderer/hooks/useAvatar'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { useMessageStyle, useSettings } from '@renderer/hooks/useSettings'
import { getMessageModelId } from '@renderer/services/MessagesService'
import { getModelName } from '@renderer/services/ModelService'
import type { Model, Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { firstLetter, isEmoji, removeLeadingEmoji } from '@renderer/utils'
import { Avatar, Checkbox, Tooltip } from 'antd'
import dayjs from 'dayjs'
import { Sparkle } from 'lucide-react'
import type { FC } from 'react'
import { memo, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import MessageTokens from './MessageTokens'
import { useIsHeadedFirstMessage } from './SegmentGroupPresentation'

interface Props {
  message: Message
  // Presentation configuration only (no topics subscription); reads just the
  // assistant name for the avatar fallback. Tolerates undefined so a missing
  // assistant degrades to the model/user name instead of throwing.
  assistant: MessageAssistantConfig | undefined
  model?: Model
  topic: Topic
  isGroupContextMessage?: boolean
}

const getAvatarSource = (isLocalAi: boolean, _modelId: string | undefined) => {
  if (isLocalAi) return AppLogo
  // Custom-connection product: no curated model icon catalog in message UI.
  return undefined
}

const MessageHeader: FC<Props> = memo(({ assistant, model, message, topic, isGroupContextMessage }) => {
  const avatar = useAvatar()
  const { theme } = useTheme()
  const { userName } = useSettings()
  const { t } = useTranslation()
  const { isBubbleStyle } = useMessageStyle()

  const { isMultiSelectMode, selectedMessageIds, handleSelectMessage } = useChatContext(topic)

  const isSelected = selectedMessageIds?.includes(message.id)

  const avatarSource = useMemo(() => getAvatarSource(isLocalAi, getMessageModelId(message)), [message])

  const getUserName = useCallback(() => {
    if (isLocalAi && message.role !== 'user') {
      return APP_NAME
    }

    if (message.role === 'assistant') {
      return getModelName(model) || getMessageModelId(message) || ''
    }

    return userName || t('common.you')
  }, [message, model, t, userName])

  const isAssistantMessage = message.role === 'assistant'
  const isUserMessage = message.role === 'user'
  const isUserBubbleMessage = isBubbleStyle && isUserMessage && !isMultiSelectMode
  // The group's label pill shares this message's band when this is the slot
  // run's first rendered message (single shared slot-first mapping). An
  // in-flow header row (assistant) indents exactly the pill's measured width
  // for the avatar/name row. A user bubble message's header is absolutely
  // positioned and reserves nothing — the bubble body never shrinks for the
  // group; the LABEL clamps to the free gap instead (see `TopicSegmentLine`) —
  // so no margin may drag its avatar here.
  const isHeadedFirst = useIsHeadedFirstMessage(topic.id, message.id) && !isUserBubbleMessage

  const username = useMemo(() => removeLeadingEmoji(getUserName()), [getUserName])
  // Missing-assistant fallback reuses the displayed name (model name/message
  // model id/user name) so the avatar initial stays consistent with the header.
  const avatarName = useMemo(() => firstLetter(assistant?.name || username).toUpperCase(), [assistant?.name, username])
  const displayModelName = model?.name?.trim()
  const modelTitle = displayModelName ?? model?.id?.trim() ?? username

  const userNameJustifyContent = useMemo(() => {
    if (!isBubbleStyle) return 'flex-start'
    if (isUserMessage && !isMultiSelectMode) return 'flex-end'
    return 'flex-start'
  }, [isBubbleStyle, isUserMessage, isMultiSelectMode])

  return (
    <Container
      className={isUserBubbleMessage ? 'message-header user-bubble-header' : 'message-header'}
      $headedFirst={isHeadedFirst}>
      {isAssistantMessage ? (
        isLocalAi ? (
          <Avatar
            src={avatarSource}
            size={35}
            style={{
              borderRadius: '25%',
              border: '1px solid var(--color-border-soft)',
              filter: theme === 'dark' ? 'invert(0.05)' : undefined
            }}>
            {avatarName}
          </Avatar>
        ) : model ? (
          <ModelAvatar model={model} size={35} />
        ) : avatarSource ? (
          <Avatar
            src={avatarSource}
            size={35}
            style={{
              borderRadius: '25%',
              border: 'none',
              filter: theme === 'dark' ? 'invert(0.05)' : undefined
            }}>
            {avatarName}
          </Avatar>
        ) : (
          <Avatar
            size={35}
            style={{
              borderRadius: '25%',
              border: 'none'
            }}>
            {avatarName}
          </Avatar>
        )
      ) : (
        <>
          {isEmoji(avatar) ? (
            <EmojiAvatar onClick={() => UserPopup.show()} size={35} fontSize={20}>
              {avatar}
            </EmojiAvatar>
          ) : isDefaultUserAvatar(avatar) ? (
            <DefaultUserAvatar size={35} onClick={() => UserPopup.show()} testId="message-user-default-avatar" />
          ) : (
            <Avatar
              src={avatar}
              size={35}
              style={{ borderRadius: '25%', cursor: 'pointer' }}
              onClick={() => UserPopup.show()}
            />
          )}
        </>
      )}
      {!isUserBubbleMessage && (
        <UserWrap>
          <HStack alignItems="center" justifyContent={userNameJustifyContent}>
            <UserName
              className="message-header-username"
              isBubbleStyle={isBubbleStyle && isUserMessage}
              theme={theme}
              title={isAssistantMessage ? modelTitle : username}>
              {username}
            </UserName>
            {isGroupContextMessage && (
              <Tooltip title={t('chat.message.useful.tip')}>
                <Sparkle fill="var(--color-primary)" strokeWidth={0} size={18} />
              </Tooltip>
            )}
          </HStack>
          <InfoWrap className="message-header-info-wrap text-(--color-text-3) text-[10px]">
            <MessageTime>{dayjs(message?.updatedAt ?? message.createdAt).format('MM/DD HH:mm')}</MessageTime>
            {isBubbleStyle && message.usage !== undefined && (
              <>
                |
                <MessageTokens message={message} />
              </>
            )}
          </InfoWrap>
        </UserWrap>
      )}
      {isMultiSelectMode && (
        <Checkbox
          checked={isSelected}
          onChange={(e) => handleSelectMessage(message.id, e.target.checked)}
          style={{ position: 'absolute', right: 0, top: 0 }}
        />
      )}
    </Container>
  )
})

MessageHeader.displayName = 'MessageHeader'

const Container = styled.div<{ $headedFirst?: boolean }>`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  position: relative;
  margin-bottom: 10px;
  user-select: none;
  // Headed-first group message: the label pill shares this band, so the whole
  // header starts past it. The width is the pill's own measured box on the
  // run host (0px before it publishes); every other header is untouched.
  margin-left: ${(props) => (props.$headedFirst ? 'var(--seg-head-pill-w, 0px)' : '0')};
  // The reserved room narrows this row: keep the name on one line (ellipsis,
  // full name stays on 'title') instead of wrapping into a taller header.
  ${(props) =>
    props.$headedFirst
      ? `
    > *:nth-child(2) {
      min-width: 0;
      overflow: hidden;
    }
    .message-header-username {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `
      : ''}
`

const UserWrap = styled.div`
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  flex: 1;
`

const InfoWrap = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
`

const UserName = styled.span<{ isBubbleStyle?: boolean; theme?: string }>`
  font-size: 14px;
  font-weight: 600;
  color: ${(props) => (props.isBubbleStyle && props.theme === 'dark' ? 'white' : 'var(--color-text)')};
`

const MessageTime = styled.div`
  font-size: 10px;
  color: var(--color-text-3);
`

export default MessageHeader
