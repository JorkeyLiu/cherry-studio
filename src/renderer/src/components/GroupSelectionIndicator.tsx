import React from 'react'
import styled from 'styled-components'

interface Props {
  isSelected: boolean
  onClick: (e: React.MouseEvent) => void
}

const GroupSelectionIndicator: React.FC<Props> = ({ isSelected, onClick }) => {
  return (
    <Container onClick={onClick} $selected={isSelected}>
      {isSelected && <CheckIcon>✓</CheckIcon>}
    </Container>
  )
}

const Container = styled.div<{ $selected: boolean }>`
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: 1.5px solid ${(p) => (p.$selected ? 'var(--color-primary)' : 'var(--color-border)')};
  background: ${(p) => (p.$selected ? 'var(--color-primary)' : 'transparent')};
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;

  &:hover {
    border-color: var(--color-primary);
  }
`

const CheckIcon = styled.span`
  color: white;
  font-size: 12px;
  line-height: 1;
`

export default React.memo(GroupSelectionIndicator)
