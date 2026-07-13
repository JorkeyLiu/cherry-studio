import { Search } from 'lucide-react'
import styled from 'styled-components'

interface Props {
  text: React.ReactNode
}

export default function Spinner({ text }: Props) {
  return (
    <Searching className="animate-pulse-color">
      <Search size={16} style={{ color: 'unset' }} />
      <span>{text}</span>
    </Searching>
  )
}
const SearchWrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  /* font-size: 14px; */
  padding: 0px;
  /* padding-left: 0; */
`
const Searching = SearchWrapper
