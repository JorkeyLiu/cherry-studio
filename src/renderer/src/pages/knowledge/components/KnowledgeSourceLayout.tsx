/**
 * Shared knowledge source layout for the bounded dialog surface.
 *
 * Every source tab (files/notes/directories/urls/sitemaps/videos) keeps its
 * existing add-flow, item actions, empty state, and indexing-progress wiring —
 * this module only replaces the `100vh`-anchored column and the overlay add
 * header with flex children that fill the dialog body and scroll internally.
 */
import { Empty } from 'antd'
import styled from 'styled-components'

export const KnowledgeEmptyView = () => <Empty style={{ margin: 20 }} styles={{ image: { display: 'none' } }} />

export const KnowledgeSourceToolbar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 16px;
  border-bottom: 0.5px solid var(--color-border);
  flex-shrink: 0;
`

export const KnowledgeSourceBody = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
`

export const KnowledgeSourceContent = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
`

export const KnowledgeSourceDropPad = styled.div`
  padding: 12px 16px 0 16px;
  flex-shrink: 0;
`

export const KnowledgeSourceScroller = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
`
