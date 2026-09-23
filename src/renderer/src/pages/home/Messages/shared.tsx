import Scrollbar from '@renderer/components/Scrollbar'
import styled from 'styled-components'

export const ScrollContainer = styled.div`
  display: flex;
  flex-direction: column-reverse;
  padding: 10px 10px 20px;
  .multi-select-mode & {
    padding-bottom: 60px;
  }
`

interface ContainerProps {
  $right?: boolean
}

export const MessagesWrapper = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
`

export const MessagesContainer = styled(Scrollbar)<ContainerProps>`
  display: flex;
  flex-direction: column-reverse;
  overflow-x: hidden;
  // Short content sizes to content height instead of stretching the full
  // wrapper height (flex:1 forced full fill, pushing the column-reverse
  // content to the visual bottom and leaving blank above Prompt).
  // flex:0 1 auto keeps shrink-to-wrapper + own overflow-y:auto scroll
  // for long content. Wrapper stays the flex:1/min-height:0 height boundary.
  flex: 0 1 auto;
  min-height: 0;
  z-index: 1;
  position: relative;
`
