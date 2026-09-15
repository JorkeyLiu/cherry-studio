import { getModelUniqId } from '@renderer/services/ModelService'
import type { Message } from '@renderer/types/newMessage'
import type { SnapshotBlockMap } from '@renderer/utils/messageUtils/snapshotBlocks'
import { Flex } from 'antd'
import { isEmpty } from 'lodash'
import React from 'react'
import styled from 'styled-components'

import MessageBlockRenderer from './Blocks'
interface Props {
  message: Message
  /**
   * Optional caller-local snapshot block map for history rendering.
   * When provided, blocks resolve from the snapshot; undefined preserves
   * the default active-chat Redux behavior.
   */
  snapshotBlocksById?: SnapshotBlockMap
}

const MessageContent: React.FC<Props> = ({ message, snapshotBlocksById }) => {
  return (
    <>
      {!isEmpty(message.mentions) && (
        <Flex gap="8px" wrap style={{ marginBottom: '10px' }}>
          {message.mentions?.map((model) => (
            <MentionTag key={getModelUniqId(model)}>{'@' + model.name}</MentionTag>
          ))}
        </Flex>
      )}
      <MessageBlockRenderer blocks={message.blocks} message={message} snapshotBlocksById={snapshotBlocksById} />
    </>
  )
}

const MentionTag = styled.span`
  color: var(--color-link);
  user-select: text;
`

// const SearchingText = styled.div`
//   font-size: 14px;
//   line-height: 1.6;
//   text-decoration: none;
//   color: var(--color-text-1);
// `

export default React.memo(MessageContent)
